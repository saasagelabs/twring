package expo.modules.cordcallservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service (type microphone) held for exactly the life of a connected call. It owns no
 * media: LiveKit does that. It keeps the process allowed to capture audio with the screen off and
 * shows the ongoing notification whose End action asks JS to hang up.
 */
class CallForegroundService : Service() {
  companion object {
    const val ACTION_START = "cord.call.START"
    const val ACTION_END = "cord.call.END"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "cord_call"
    private const val NOTIFICATION_ID = 4711
    private const val TAG = "CordCallService"

    /** Set by the module; forwards the notification's End action to JS. */
    @Volatile var onEndPressed: (() -> Unit)? = null

    /** Set by the module; tells JS that startForeground was refused (logged as background_start_failed). */
    @Volatile var onStartRefused: ((String) -> Unit)? = null
  }

  /** True once startForeground succeeded; a stop before that must not crash the app. */
  private var inForeground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_END) {
      val forward = onEndPressed
      // JS hangs up and stops the service (or stops it itself when no call is active); without a
      // JS runtime, stop here so nothing pins it. A plain started service is never left running.
      if (forward != null) forward() else stopSafely()
      return START_NOT_STICKY
    }
    // startForeground first, before any other work: startForegroundService() gives only seconds.
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Twring call in progress"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        buildNotification(title, text),
        foregroundType(),
      )
      inForeground = true
    } catch (error: Exception) {
      // Android 14+ refuses the microphone type unless the app is visible with RECORD_AUDIO granted.
      Log.w(TAG, "startForeground refused: ${error.message}")
      onStartRefused?.invoke(error.message ?: "startForeground refused")
      stopSafely()
    }
    // A restarted process has no call to keep alive.
    return START_NOT_STICKY
  }

  /**
   * Stops without the "did not then call startForeground" crash: a service started with
   * startForegroundService() must enter the foreground before it stops, so do that briefly first.
   */
  private fun stopSafely() {
    if (!inForeground) {
      try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification("Twring", ""), foregroundType())
      } catch (_: Exception) {
        // Refused again; stopSelf below is still the best we can do.
      }
    }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    inForeground = false
    stopSelf()
  }

  private fun foregroundType(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0

  override fun onDestroy() {
    inForeground = false
    super.onDestroy()
  }

  private fun buildNotification(title: String, text: String): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shows while a Twring call is in progress"
          setShowBadge(false)
        },
      )
    }
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, flags)
    }
    val end = PendingIntent.getService(
      this,
      1,
      Intent(this, CallForegroundService::class.java).setAction(ACTION_END),
      flags,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_twring)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(open)
      .addAction(0, "End", end)
      .build()
  }
}
