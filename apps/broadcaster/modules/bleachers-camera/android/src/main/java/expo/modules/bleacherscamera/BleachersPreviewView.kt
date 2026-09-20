package expo.modules.bleacherscamera

import android.content.Context
import android.view.SurfaceHolder
import android.view.SurfaceView

class BleachersPreviewView(context: Context) : SurfaceView(context), SurfaceHolder.Callback {
  companion object { var listener: ((android.view.Surface?) -> Unit)? = null }
  init {
    // Camera sensor output is landscape-clockwise on this portrait device.
    // Rotate the preview surface counter-clockwise to match the UI.
    rotation = 0f
    holder.addCallback(this)
  }
  override fun surfaceCreated(holder: SurfaceHolder) { listener?.invoke(holder.surface) }
  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) { listener?.invoke(holder.surface) }
  override fun surfaceDestroyed(holder: SurfaceHolder) { listener?.invoke(null) }
}
