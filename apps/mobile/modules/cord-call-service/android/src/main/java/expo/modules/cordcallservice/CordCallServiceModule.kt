package expo.modules.cordcallservice

import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS bridge for CallForegroundService (ADR-019) and incoming agent calls (Ring.kt). */
class CordCallServiceModule : Module() {
  @Volatile private var callScreenActive = false
  private var screenActivity: Activity? = null
  private var proximityLock: PowerManager.WakeLock? = null

  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  override fun definition() = ModuleDefinition {
    Name("CordCallService")

    Events("onEndPressed", "onStartRefused", "onRing", "onRingCancel", "onRingDeclined", "onPushToken")

    OnCreate {
      CallForegroundService.onEndPressed = { sendEvent("onEndPressed", emptyMap<String, Any>()) }
      CallForegroundService.onStartRefused = { detail ->
        sendEvent("onStartRefused", mapOf("detail" to detail))
      }
      Ring.listener = object : RingListener {
        override fun onRing(data: Map<String, String>) = sendEvent("onRing", data)
        override fun onCancel(inviteId: String, status: String) =
          sendEvent("onRingCancel", mapOf("invite_id" to inviteId, "status" to status))
        override fun onDeclined(inviteId: String) =
          sendEvent("onRingDeclined", mapOf("invite_id" to inviteId))
        override fun onToken(token: String) = sendEvent("onPushToken", mapOf("token" to token))
      }
    }

    OnDestroy {
      callScreenActive = false
      screenActivity?.let { clearCallScreen(it) }
      CallForegroundService.onEndPressed = null
      CallForegroundService.onStartRefused = null
      Ring.listener = null
      // The JS runtime is going away (reload or teardown): no call is left for the service to keep.
      appContext.reactContext?.let {
        it.stopService(Intent(it, CallForegroundService::class.java))
      }
    }

    OnActivityEntersForeground {
      if (callScreenActive) appContext.currentActivity?.let { applyCallScreen(it) }
    }

    OnActivityDestroys {
      screenActivity?.let { clearCallScreen(it) }
    }

    Function("setCallScreen") { active: Boolean ->
      callScreenActive = active
      (if (active) appContext.currentActivity else screenActivity ?: appContext.currentActivity)?.let { activity ->
        if (active) applyCallScreen(activity) else clearCallScreen(activity)
      }
    }

    /** Shows the ongoing call notification and keeps the process alive. Call while the app is visible. */
    AsyncFunction("start") { title: String, text: String ->
      val intent = Intent(context, CallForegroundService::class.java)
        .setAction(CallForegroundService.ACTION_START)
        .putExtra(CallForegroundService.EXTRA_TITLE, title)
        .putExtra(CallForegroundService.EXTRA_TEXT, text)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (error: Exception) {
        // Android 12+ refuses to start a foreground service from the background.
        throw CodedException("ERR_CALL_SERVICE_START", error.message ?: "start refused", error)
      }
    }

    /** Idempotent. */
    AsyncFunction("stop") {
      context.stopService(Intent(context, CallForegroundService::class.java))
    }

    // Incoming agent calls (Ring.kt).

    /** The FCM registration token, or null when Firebase is not configured in this build. */
    AsyncFunction("getPushToken") { promise: Promise ->
      if (FirebaseApp.getApps(context).isEmpty()) {
        promise.resolve(null)
        return@AsyncFunction
      }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (task.isSuccessful) promise.resolve(task.result)
        else promise.reject(CodedException("ERR_PUSH_TOKEN", "token unavailable", task.exception))
      }
    }

    /** A self-hosted server's seal key (32 bytes, unpadded base64url), for sealed pushes (Sealed.kt). */
    AsyncFunction("setSealKey") { serverId: String, keyB64url: String ->
      SealKeys.set(context, serverId, keyB64url)
    }

    AsyncFunction("removeSealKey") { serverId: String ->
      SealKeys.remove(context, serverId)
    }

    /** True when this phone opens the shared known-answer envelope. */
    AsyncFunction("sealSelfTest") {
      Sealed.selfTest()
    }

    /** Synchronous so sign-out clears the native gate before its network request. */
    Function("setRingAccount") { userRef: String? ->
      Ring.setAccount(context, userRef)
    }

    /** Best effort on sign-out. A later getPushToken creates a fresh registration token. */
    AsyncFunction("deletePushToken") { promise: Promise ->
      if (FirebaseApp.getApps(context).isEmpty()) {
        promise.resolve(null)
        return@AsyncFunction
      }
      FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { task ->
        if (task.isSuccessful) promise.resolve(null)
        else promise.reject(CodedException("ERR_PUSH_TOKEN_DELETE", "token deletion failed", task.exception))
      }
    }

    /** Whether the ring can show: notifications allowed, and the full-screen intent (Android 14+). */
    Function("ringPermissions") {
      val manager = context.getSystemService(NotificationManager::class.java)
      val fullScreen =
        if (Build.VERSION.SDK_INT >= 34) manager?.canUseFullScreenIntent() ?: false else true
      val channelOn = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
        manager?.getNotificationChannel(Ring.CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE
      mapOf(
        "notifications" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "fullScreen" to fullScreen,
        "channel" to channelOn,
      )
    }

    /** Android 14+: the "Full screen notifications" page for this app. */
    Function("openFullScreenIntentSettings") {
      val intent = if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        notificationSettingsIntent()
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    Function("openNotificationSettings") {
      context.startActivity(notificationSettingsIntent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Stops the ring for an invite handled in the app. */
    Function("clearRing") { inviteId: String ->
      Ring.clear(context, inviteId)
    }

    /** Clears the missed-call notifications once the owner has seen them in the app. */
    Function("clearMissedCalls") {
      Ring.clearMissed(context)
    }

    Function("clearMessages") { agentId: String ->
      Messages.clearMessages(context, agentId)
    }

    /** Declines tapped on the notification that JS has not sent yet; clears the queue. */
    Function("takePendingDeclines") {
      Ring.takeDeclines(context)
    }

    /** Puts one back after a send failed for a reason worth retrying. */
    Function("queueDecline") { inviteId: String ->
      Ring.queueDecline(context, inviteId)
    }

    /** Only while the incoming-call or call screen shows: the app never sits over the lock screen otherwise. */
    Function("setShowWhenLocked") { on: Boolean ->
      appContext.currentActivity?.let { Ring.showWhenLocked(it, on) }
    }

    OnNewIntent { intent ->
      // A ring's full-screen intent: show over the lock screen before JS gets to it.
      if (Ring.isRingIntent(intent)) appContext.currentActivity?.let { Ring.showWhenLocked(it, true) }
    }
  }

  private fun notificationSettingsIntent(): Intent =
    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

  private fun applyCallScreen(activity: Activity) {
    activity.runOnUiThread {
      if (!callScreenActive) return@runOnUiThread
      screenActivity?.let { if (it !== activity) clearCallScreen(it) }
      screenActivity = activity
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) activity.setShowWhenLocked(true)
      else {
        @Suppress("DEPRECATION")
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
      }
      if (proximityLock?.isHeld == true) return@runOnUiThread
      try {
        val manager = context.getSystemService(PowerManager::class.java) ?: return@runOnUiThread
        if (!manager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return@runOnUiThread
        proximityLock = manager.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "CORD:call-proximity").apply {
          setReferenceCounted(false)
          acquire()
        }
      } catch (_: Exception) {
        // The call remains usable on devices without a supported proximity wake lock.
      }
    }
  }

  private fun clearCallScreen(activity: Activity) {
    activity.runOnUiThread {
      activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) activity.setShowWhenLocked(false)
      else {
        @Suppress("DEPRECATION")
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
      }
      try {
        proximityLock?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
      } catch (_: Exception) {
        // Releasing a lock the device has already dropped must not crash teardown.
      }
      proximityLock = null
      if (screenActivity === activity) screenActivity = null
    }
  }
}
