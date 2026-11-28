package expo.modules.twringaudioroute

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import androidx.annotation.RequiresApi
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executor

/**
 * Call audio routes and phone call interruptions (src/platform/audio-route.ts).
 *
 * Routes: Android 12+ lists AudioManager.availableCommunicationDevices, so Bluetooth shows only with
 * a call link (SCO or LE Audio headset), and pins the choice with setCommunicationDevice. Older
 * Android lists the output devices, where an HFP headset shows as TYPE_BLUETOOTH_SCO and an
 * A2DP-only speaker does not. Changes arrive through AudioDeviceCallback and, on 12+,
 * OnCommunicationDeviceChangedListener, screen off included.
 *
 * Interruptions: no new permission. Android 12+ watches the audio mode (a cellular or other app's
 * call puts it in MODE_RINGTONE / MODE_IN_CALL); older Android uses the call state, which needs no
 * permission there.
 */
class TwringAudioRouteModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val mainExecutor = Executor { main.post(it) }
  private var deviceCallback: AudioDeviceCallback? = null
  private var commListener: Any? = null
  private var modeListener: Any? = null
  private var phoneListener: PhoneStateListener? = null
  private var interrupted = false

  /** The call token of the last setCommunicationDevice, so a call end never clears the next call. */
  private var lastToken: Int? = null

  private val audio: AudioManager
    get() =
      requireNotNull(appContext.reactContext) { "React context is not available" }
        .getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("TwringAudioRoute")
    Events("onRoutesChanged", "onInterruption")

    Function("listCallDevices") {
      val devices =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.availableCommunicationDevices
        else audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
      devices.mapNotNull { name(it.type) }.distinct()
    }

    Function("setCommunicationDevice") { chosen: String, token: Int? ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
      lastToken = token
      val device = audio.availableCommunicationDevices.firstOrNull { output(it.type) == chosen }
      device != null && audio.setCommunicationDevice(device)
    }

    /** Android 12+: the output the OS really routes the call to, or null (none or unknown type). */
    Function("currentCallDevice") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function null
      audio.communicationDevice?.let { callOutput(it.type) }
    }

    Function("callModeActive") { audio.mode == AudioManager.MODE_IN_COMMUNICATION }

    /** Clears the device unless a newer call set it since (token mismatch). */
    Function("clearCommunicationDevice") { token: Int? ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function
      if (token != null && token != lastToken) return@Function
      audio.clearCommunicationDevice()
      lastToken = null
    }

    Function("startWatching") { main.post { start() } }
    Function("stopWatching") { main.post { stop() } }

    OnDestroy { main.post { stop() } }
  }

  private fun start() {
    if (deviceCallback != null) return
    val callback =
      object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = routesChanged()

        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = routesChanged()
      }
    audio.registerAudioDeviceCallback(callback, main)
    deviceCallback = callback
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) startS() else startLegacy()
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun startS() {
    val comm = AudioManager.OnCommunicationDeviceChangedListener { routesChanged() }
    audio.addOnCommunicationDeviceChangedListener(mainExecutor, comm)
    commListener = comm
    val mode = AudioManager.OnModeChangedListener { onMode(it) }
    audio.addOnModeChangedListener(mainExecutor, mode)
    modeListener = mode
  }

  @Suppress("DEPRECATION")
  private fun startLegacy() {
    val context = appContext.reactContext ?: return
    val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
    val listener =
      object : PhoneStateListener() {
        @Deprecated("Deprecated in Java")
        override fun onCallStateChanged(state: Int, phoneNumber: String?) {
          interruption(state != TelephonyManager.CALL_STATE_IDLE)
        }
      }
    try {
      telephony.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
      phoneListener = listener
    } catch (_: SecurityException) {
      // Some vendors still ask for READ_PHONE_STATE: interruptions are then not detected.
    }
  }

  @Suppress("DEPRECATION")
  private fun stop() {
    deviceCallback?.let { audio.unregisterAudioDeviceCallback(it) }
    deviceCallback = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (commListener as? AudioManager.OnCommunicationDeviceChangedListener)?.let {
        audio.removeOnCommunicationDeviceChangedListener(it)
      }
      (modeListener as? AudioManager.OnModeChangedListener)?.let {
        audio.removeOnModeChangedListener(it)
      }
    }
    commListener = null
    modeListener = null
    phoneListener?.let { listener ->
      val context = appContext.reactContext
      val telephony = context?.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      telephony?.listen(listener, PhoneStateListener.LISTEN_NONE)
    }
    phoneListener = null
    interrupted = false
  }

  private fun onMode(mode: Int) {
    when (mode) {
      AudioManager.MODE_RINGTONE,
      AudioManager.MODE_IN_CALL,
      AudioManager.MODE_CALL_SCREENING -> interruption(true)
      AudioManager.MODE_NORMAL,
      AudioManager.MODE_IN_COMMUNICATION -> interruption(false)
    }
  }

  private fun interruption(active: Boolean) {
    if (active == interrupted) return
    interrupted = active
    sendEvent("onInterruption", bundleOf("phase" to if (active) "began" else "ended"))
  }

  private fun routesChanged() = sendEvent("onRoutesChanged", bundleOf())

  private fun name(type: Int): String? =
    when (type) {
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_sco"
      AudioDeviceInfo.TYPE_BLE_HEADSET -> "ble_headset"
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_a2dp"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headphones"
      AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
      else -> null
    }

  /** The JS output a communication device stands for (audio-routes.ts outputsFromDevices). */
  private fun output(type: Int): String? =
    when (name(type)) {
      "bluetooth_sco", "ble_headset" -> "bluetooth"
      "wired_headset", "wired_headphones", "usb_headset" -> "headset"
      "speaker" -> "speaker"
      "earpiece" -> "earpiece"
      else -> null
    }

  /** The JS output for a read-back communication device; an unknown type logs its raw number. */
  private fun callOutput(type: Int): String? =
    when (type) {
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "headset"
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
      else -> {
        Log.w(TAG, "unknown call device type $type")
        null
      }
    }

  private companion object {
    const val TAG = "TwringAudioRoute"
  }
}
