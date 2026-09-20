package expo.modules.bleacherscamera

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.*
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.view.Surface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque

/** Hardware encoder only. No relay, MoQT, JPEG, or network ownership here. */
class BleachersCameraModule : Module() {
  private val thread = HandlerThread("BleachersH264").apply { start() }
  private val handler = Handler(thread.looper)
  // MediaCodec callbacks must never share the React Native bridge handler.
  // Large frame marshaling can delay that handler long enough to starve the
  // encoder's output buffers, which in turn stalls Camera2's input surface.
  private val codecThread = HandlerThread("BleachersCodecDrain").apply { start() }
  private val codecHandler = Handler(codecThread.looper)
  private val framesLock = Any()
  private val audioFramesLock = Any()
  private var camera: CameraDevice? = null
  private var capture: CameraCaptureSession? = null
  private var codec: MediaCodec? = null
  private var surface: Surface? = null
  private var previewSurface: Surface? = null
  @Volatile private var activeGeneration = 0
  @Volatile private var generation = 0
  private var starting: Promise? = null
  @Volatile private var failure: String? = null
  private var configBytes = byteArrayOf()
  private var waitingForKeyframe = true
  private val frames = ArrayDeque<Map<String, Any>>()
  private var audioCodec: MediaCodec? = null
  private var audioRecord: AudioRecord? = null
  private var audioWorker: Thread? = null
  @Volatile private var audioRunning = false
  @Volatile private var audioFailure: String? = null
  private var audioConfigBytes = byteArrayOf()
  private val audioFrames = ArrayDeque<Map<String, Any>>()
  @Volatile private var lastVideoOutputMs = 0L
  private var restartingVideo = false
  private var videoWidth = 1280
  private var videoHeight = 720
  private var videoFps = 24
  private var videoBitrate = 1_200_000

  override fun definition() = ModuleDefinition {
    Name("BleachersCamera")
    BleachersPreviewView.listener = { next -> handler.post {
      if (previewSurface === next) return@post
      previewSurface = next
      if (camera != null && surface != null) configureCaptureSession(activeGeneration)
    } }
    View(BleachersPreviewView::class) { }
    AsyncFunction("start") { width: Int, height: Int, fps: Int, bitrate: Int, promise: Promise ->
      handler.post {
        if (codec != null || starting != null) {
          promise.reject("CAMERA_ACTIVE", "Camera encoder is already running", null)
        } else {
          starting = promise
          try { startCamera(width, height, fps, bitrate) }
          catch (e: Exception) { fail(e.message ?: "Camera start failed") }
        }
      }
    }
    AsyncFunction("readFrame") { promise: Promise ->
      handler.post {
        val error = failure
        if (error != null) promise.reject("CAMERA_FAILED", error, null)
        else {
          val frame: Map<String, Any>? = synchronized(framesLock) {
            if (frames.isEmpty()) null else frames.removeFirst()
          }
          promise.resolve(frame)
        }
      }
    }
    AsyncFunction("requestKeyframe") { promise: Promise ->
      handler.post {
        try { requestSync(); promise.resolve(null) }
        catch (e: Exception) { promise.reject("KEYFRAME_FAILED", e.message, e) }
      }
    }
    AsyncFunction("startAudio") { promise: Promise ->
      handler.post {
        if (audioCodec != null) promise.reject("AUDIO_ACTIVE", "Audio encoder is already running", null)
        else try { startAudio(); promise.resolve(null) }
        catch (e: Exception) { promise.reject("AUDIO_FAILED", e.message ?: "Audio start failed", e) }
      }
    }
    AsyncFunction("readAudioFrame") { promise: Promise ->
      handler.post {
        audioFailure?.let { promise.reject("AUDIO_FAILED", it, null); return@post }
        val frame = synchronized(audioFramesLock) { if (audioFrames.isEmpty()) null else audioFrames.removeFirst() }
        promise.resolve(frame)
      }
    }
    AsyncFunction("stop") { promise: Promise ->
      handler.post { release(); promise.resolve(null) }
    }
    OnDestroy { handler.post { release(); thread.quitSafely(); codecThread.quitSafely() } }
  }

  @SuppressLint("MissingPermission")
  private fun startCamera(width: Int, height: Int, fps: Int, bitrate: Int) {
    require(width in 160..1920 && height in 120..1920 && width % 2 == 0 && height % 2 == 0)
    require(fps in 1..30 && bitrate in 100_000..8_000_000)
    val context = appContext.reactContext ?: error("React context unavailable")
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val id = manager.cameraIdList.firstOrNull {
      manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
    } ?: error("Back camera unavailable")
    failure = null
    videoWidth = width
    videoHeight = height
    videoFps = fps
    videoBitrate = bitrate
    lastVideoOutputMs = SystemClock.elapsedRealtime()
    configBytes = byteArrayOf()
    waitingForKeyframe = true
    val current = ++generation
    activeGeneration = current
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    codec = encoder
    encoder.setCallback(object : MediaCodec.Callback() {
      override fun onInputBufferAvailable(c: MediaCodec, index: Int) {}
      override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
        if (current == generation) fail(e.message ?: "H264 encoder failed")
      }
      override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
        if (current != generation) return
        configBytes = listOf("csd-0", "csd-1").mapNotNull { key ->
          format.getByteBuffer(key)?.duplicate()?.let { b -> ByteArray(b.remaining()).also { b.get(it) } }
        }.fold(byteArrayOf()) { a, b -> a + b }
      }
      override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        if (current != generation) return
        try {
          lastVideoOutputMs = SystemClock.elapsedRealtime()
          if (info.size <= 0) return
          val buffer = c.getOutputBuffer(index) ?: return
          buffer.position(info.offset)
          buffer.limit(info.offset + info.size)
          val bytes = toAnnexB(ByteArray(info.size).also { buffer.get(it) })
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
            configBytes = bytes
            return
          }
          val keyframe = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
          // Dropping an inter frame invalidates the following dependent frames.
          // Discard the backlog and wait for an IDR instead of forwarding damage.
          val backlogFull = synchronized(framesLock) { frames.size >= 4 }
          if (backlogFull) {
            synchronized(framesLock) { frames.clear() }
            waitingForKeyframe = true
            requestSync()
          }
          if (waitingForKeyframe && !keyframe) return
          if (keyframe && configBytes.isEmpty()) { requestSync(); return }
          waitingForKeyframe = false
          synchronized(framesLock) {
            frames.addLast(mapOf(
              "payload" to (if (keyframe) configBytes + bytes else bytes),
              "timestampUs" to info.presentationTimeUs.toDouble(),
              "keyframe" to keyframe, "width" to width, "height" to height
            ))
          }
        } catch (e: Exception) {
          handler.post { if (current == generation) fail(e.message ?: "Encoder output failed") }
        } finally { runCatching { c.releaseOutputBuffer(index, false) } }
      }
    }, codecHandler)
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
    }
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    val input = encoder.createInputSurface()
    surface = input
    encoder.start()
    manager.openCamera(id, object : CameraDevice.StateCallback() {
      override fun onOpened(device: CameraDevice) {
        if (current != generation) { device.close(); return }
        camera = device
        configureCaptureSession(current)
      }
      override fun onDisconnected(device: CameraDevice) {
        device.close()
        if (current == generation) fail("Camera disconnected")
      }
      override fun onError(device: CameraDevice, error: Int) {
        device.close()
        if (current == generation) fail("Camera error $error")
      }
    }, handler)
    handler.postDelayed({ if (current == generation && starting != null) fail("Camera startup timed out") }, 10_000)
  }

  private fun configureCaptureSession(current: Int) {
    val device = camera ?: return
    val encoderSurface = surface ?: return
    runCatching { capture?.stopRepeating() }
    runCatching { capture?.close() }
    capture = null
    try {
      val outputs = listOfNotNull(encoderSurface, previewSurface)
      device.createCaptureSession(outputs, object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(session: CameraCaptureSession) {
          if (current != generation) { session.close(); return }
          capture = session
          try {
            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
              addTarget(encoderSurface)
              previewSurface?.let { addTarget(it) }
            }
            session.setRepeatingRequest(request.build(), null, handler)
            starting?.resolve(null)
            starting = null
            scheduleVideoWatchdog(current)
          } catch (e: Exception) { fail(e.message ?: "Capture failed") }
        }
        override fun onConfigureFailed(session: CameraCaptureSession) {
          if (current == generation) fail("Camera configuration failed")
        }
      }, handler)
    } catch (e: Exception) { fail(e.message ?: "Camera configuration failed") }
  }

  private fun requestSync() {
    codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
  }

  private fun scheduleVideoWatchdog(current: Int) {
    handler.postDelayed({
      if (current != generation || codec == null || restartingVideo) return@postDelayed
      val stalledMs = SystemClock.elapsedRealtime() - lastVideoOutputMs
      if (stalledMs > 4_000) restartVideoCapture("No encoded video for ${stalledMs}ms")
      else scheduleVideoWatchdog(current)
    }, 1_000)
  }

  /** Recover from vendor H.264 firmware stalls without ending the MoQ session. */
  private fun restartVideoCapture(reason: String) {
    if (restartingVideo) return
    restartingVideo = true
    releaseVideo()
    handler.postDelayed({
      try {
        restartingVideo = false
        startCamera(videoWidth, videoHeight, videoFps, videoBitrate)
      } catch (e: Exception) {
        restartingVideo = false
        fail("Video recovery failed after $reason: ${e.message}")
      }
    }, 750)
  }

  @SuppressLint("MissingPermission")
  private fun startAudio() {
    val context = appContext.reactContext ?: error("React context unavailable")
    if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
      error("Microphone permission is required")
    }
    val sampleRate = 48_000
    val channelMask = AudioFormat.CHANNEL_IN_MONO
    val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
    require(minBuffer > 0) { "Microphone format unavailable" }
    val record = AudioRecord(MediaRecorder.AudioSource.CAMCORDER, sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuffer, 8_192))
    require(record.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, 64_000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4_096)
    }
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()
    audioConfigBytes = byteArrayOf()
    audioFailure = null
    audioCodec = encoder
    audioRecord = record
    audioRunning = true
    record.startRecording()
    audioWorker = Thread({ encodeAudioLoop(encoder, record, sampleRate) }, "BleachersAac").apply { start() }
  }

  private fun encodeAudioLoop(encoder: MediaCodec, record: AudioRecord, sampleRate: Int) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val pcm = ByteArray(2_048)
    val info = MediaCodec.BufferInfo()
    var samplesWritten = 0L
    try {
      while (audioRunning && encoder === audioCodec) {
        val inputIndex = encoder.dequeueInputBuffer(10_000)
        if (inputIndex >= 0) {
          val input = encoder.getInputBuffer(inputIndex) ?: continue
          input.clear()
          val bytesRead = record.read(pcm, 0, minOf(pcm.size, input.remaining()), AudioRecord.READ_BLOCKING)
          if (bytesRead > 0) {
            input.put(pcm, 0, bytesRead)
            encoder.queueInputBuffer(inputIndex, 0, bytesRead, samplesWritten * 1_000_000L / sampleRate, 0)
            samplesWritten += bytesRead / 2
          }
        }
        while (true) {
          val outputIndex = encoder.dequeueOutputBuffer(info, 0)
          when {
            outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              audioConfigBytes = encoder.outputFormat.getByteBuffer("csd-0")?.duplicate()?.let { buffer -> ByteArray(buffer.remaining()).also { buffer.get(it) } } ?: byteArrayOf()
            }
            outputIndex >= 0 -> {
              try {
                if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                  val output = encoder.getOutputBuffer(outputIndex) ?: continue
                  output.position(info.offset); output.limit(info.offset + info.size)
                  val payload = ByteArray(info.size).also { output.get(it) }
                  synchronized(audioFramesLock) {
                    while (audioFrames.size >= 12) audioFrames.removeFirst()
                    audioFrames.addLast(mapOf("payload" to payload, "timestampUs" to info.presentationTimeUs.toDouble(), "config" to audioConfigBytes, "sampleRate" to sampleRate, "channels" to 1))
                  }
                }
              } finally { encoder.releaseOutputBuffer(outputIndex, false) }
            }
            else -> break
          }
        }
      }
    } catch (e: Exception) {
      if (audioRunning) audioFailure = e.message ?: "Audio encoder failed"
    }
  }

  /** MediaCodec vendors differ: some emit Annex B, others AVC length prefixes. */
  private fun toAnnexB(input: ByteArray): ByteArray {
    if (input.size < 4 || (input[0] == 0.toByte() && input[1] == 0.toByte() && (input[2] == 1.toByte() || (input[2] == 0.toByte() && input[3] == 1.toByte())))) return input
    var offset = 0
    val output = ArrayList<Byte>()
    while (offset + 4 <= input.size) {
      val size = ((input[offset].toInt() and 0xff) shl 24) or ((input[offset + 1].toInt() and 0xff) shl 16) or ((input[offset + 2].toInt() and 0xff) shl 8) or (input[offset + 3].toInt() and 0xff)
      offset += 4
      if (size <= 0 || offset + size > input.size) return input
      output.add(0); output.add(0); output.add(0); output.add(1)
      for (index in offset until offset + size) output.add(input[index])
      offset += size
    }
    return if (offset == input.size) output.toByteArray() else input
  }

  private fun fail(message: String) {
    failure = message
    starting?.reject("CAMERA_FAILED", message, null)
    starting = null
    release()
  }

  private fun release() {
    releaseVideo()
    audioRunning = false
    runCatching { audioRecord?.stop() }
    runCatching { audioRecord?.release() }
    audioRecord = null
    runCatching { audioCodec?.stop() }
    runCatching { audioCodec?.release() }
    audioCodec = null
    audioWorker?.interrupt()
    audioWorker = null
    synchronized(audioFramesLock) { audioFrames.clear() }
    audioConfigBytes = byteArrayOf()
  }

  private fun releaseVideo() {
    generation++
    starting?.reject("CAMERA_STOPPED", "Camera stopped during startup", null)
    starting = null
    runCatching { capture?.stopRepeating() }
    runCatching { capture?.close() }
    capture = null
    camera?.close()
    camera = null
    runCatching { codec?.stop() }
    runCatching { codec?.release() }
    codec = null
    surface?.release()
    surface = null
    synchronized(framesLock) { frames.clear() }
    configBytes = byteArrayOf()
  }
}
