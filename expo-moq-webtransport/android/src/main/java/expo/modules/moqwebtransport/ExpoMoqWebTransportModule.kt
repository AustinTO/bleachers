package expo.modules.moqwebtransport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import uniffi.web_transport.Client
import uniffi.web_transport.ClientConfig
import uniffi.web_transport.CongestionControl
import uniffi.web_transport.RecvStream
import uniffi.web_transport.SendStream
import uniffi.web_transport.Session
import uniffi.web_transport.MoqPublisher
import uniffi.web_transport.MoqTrack

class ExpoMoqWebTransportModule : Module() {
  private val clients = ConcurrentHashMap<String, Client>()
  private val sessions = ConcurrentHashMap<String, Session>()
  private val sendStreams = ConcurrentHashMap<String, SendStream>()
  private val recvStreams = ConcurrentHashMap<String, RecvStream>()
  private val publishers = ConcurrentHashMap<String, MoqPublisher>()
  private val publisherTracks = ConcurrentHashMap<String, Pair<String, MoqTrack>>()

  override fun definition() = ModuleDefinition {
    Name("ExpoMoqWebTransport")

    AsyncFunction("moqConnectPublisher") Coroutine { relayUrl: String, broadcastName: String ->
      val publisher = MoqPublisher.connect(relayUrl, broadcastName)
      val id = UUID.randomUUID().toString()
      publishers[id] = publisher
      id
    }
    AsyncFunction("moqPublishTrack") Coroutine { publisherId: String, namespace: List<String>, name: String ->
      val publisher = publishers[publisherId] ?: error("Unknown publisher")
      val track = publisher.publishTrack(namespace, name)
      val id = UUID.randomUUID().toString()
      publisherTracks[id] = Pair(publisherId, track)
      id
    }
    AsyncFunction("moqSendObject") Coroutine { trackId: String, payload: ByteArray, timestampUs: Double, keyframe: Boolean ->
      require(timestampUs >= 0 && timestampUs <= 9007199254740991.0 && timestampUs % 1.0 == 0.0)
      (publisherTracks[trackId] ?: error("Unknown track")).second.sendObject(payload, timestampUs.toULong(), keyframe)
    }
    AsyncFunction("moqCheckPublisher") Coroutine { publisherId: String ->
      (publishers[publisherId] ?: error("Unknown publisher")).check()
    }
    AsyncFunction("moqClosePublisher") Coroutine { publisherId: String ->
      publishers.remove(publisherId)?.let { it.shutdown(); it.destroy() }
      publisherTracks.entries.removeIf { entry ->
        if (entry.value.first == publisherId) { entry.value.second.destroy(); true } else false
      }
    }

    AsyncFunction("connect") Coroutine {
      url: String,
      protocols: List<String>,
      noCertificateVerification: Boolean,
      maxIdleTimeoutSecs: Double?,
      keepAliveIntervalSecs: Double? ->
      val config = ClientConfig(
        serverCertificateHashes = null,
        noCertVerification = noCertificateVerification,
        congestionControl = CongestionControl.DEFAULT,
        maxIdleTimeoutSecs = maxIdleTimeoutSecs,
        keepAliveIntervalSecs = keepAliveIntervalSecs
      )
      val client = Client(config)
      val session = client.connectWithProtocols(url, protocols)
      val id = UUID.randomUUID().toString()
      clients[id] = client
      sessions[id] = session

      mapOf(
        "sessionId" to id,
        "protocol" to session.protocol(),
        "maxDatagramSize" to session.maxDatagramSize().toDouble()
      )
    }

    AsyncFunction("close") Coroutine { sessionId: String, code: Int, reason: String ->
      requireSession(sessionId).close(code.toUInt(), reason)
    }

    AsyncFunction("waitClosed") Coroutine { sessionId: String ->
      val session = requireSession(sessionId)
      session.waitClosed()
      val info = session.closeInfo()
      mapOf("closeCode" to info.closeCode.toDouble(), "reason" to info.reason)
    }

    AsyncFunction("releaseSession") Coroutine { sessionId: String ->
      sessions.remove(sessionId)
      clients.remove(sessionId)?.close(0uL, "")
    }

    AsyncFunction("openUni") Coroutine { sessionId: String ->
      storeSend(requireSession(sessionId).openUni())
    }

    AsyncFunction("openBi") Coroutine { sessionId: String ->
      val stream = requireSession(sessionId).openBi()
      mapOf(
        "sendStreamId" to storeSend(stream.send),
        "recvStreamId" to storeRecv(stream.recv)
      )
    }

    AsyncFunction("acceptUni") Coroutine { sessionId: String ->
      storeRecv(requireSession(sessionId).acceptUni())
    }

    AsyncFunction("acceptBi") Coroutine { sessionId: String ->
      val stream = requireSession(sessionId).acceptBi()
      mapOf(
        "sendStreamId" to storeSend(stream.send),
        "recvStreamId" to storeRecv(stream.recv)
      )
    }

    AsyncFunction("sendWrite") Coroutine { streamId: String, data: ByteArray ->
      requireSend(streamId).write(data)
    }

    AsyncFunction("sendFinish") Coroutine { streamId: String ->
      requireSend(streamId).finish()
    }

    AsyncFunction("sendReset") Coroutine { streamId: String, code: Int ->
      requireSend(streamId).reset(code.toUInt())
    }

    AsyncFunction("releaseSendStream") Coroutine { streamId: String ->
      sendStreams.remove(streamId)
    }

    AsyncFunction("recvRead") Coroutine { streamId: String, maxBytes: Int ->
      requireRecv(streamId).read(maxBytes.toULong())
    }

    AsyncFunction("recvStop") Coroutine { streamId: String, code: Int ->
      requireRecv(streamId).stop(code.toUInt())
    }

    AsyncFunction("releaseRecvStream") Coroutine { streamId: String ->
      recvStreams.remove(streamId)
    }

    AsyncFunction("sendDatagram") Coroutine { sessionId: String, data: ByteArray ->
      requireSession(sessionId).sendDatagram(data)
    }

    AsyncFunction("receiveDatagram") Coroutine { sessionId: String ->
      requireSession(sessionId).receiveDatagram()
    }
  }

  private fun storeSend(stream: SendStream): String {
    val id = UUID.randomUUID().toString()
    sendStreams[id] = stream
    return id
  }

  private fun storeRecv(stream: RecvStream): String {
    val id = UUID.randomUUID().toString()
    recvStreams[id] = stream
    return id
  }

  private fun requireSession(id: String): Session =
    sessions[id] ?: error("Unknown WebTransport session: $id")

  private fun requireSend(id: String): SendStream =
    sendStreams[id] ?: error("Unknown WebTransport send stream: $id")

  private fun requireRecv(id: String): RecvStream =
    recvStreams[id] ?: error("Unknown WebTransport receive stream: $id")
}
