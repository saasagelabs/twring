package expo.modules.cordcallservice

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import org.json.JSONArray
import org.json.JSONObject

/** What the module forwards to JS while a JS runtime exists. */
interface RingListener {
  fun onRing(data: Map<String, String>)
  fun onCancel(inviteId: String, status: String)
  fun onDeclined(inviteId: String)
  fun onToken(token: String)
}

/**
 * The incoming agent call ("the agent rings you"). Deliberately thin: it shows and clears the
 * ringing notification and remembers declines made while JS was not running. Every API call and
 * all validation that matters happen in JS (src/ring), which holds the sign-in session.
 */
object Ring {
  const val CHANNEL_ID = "cord_incoming_call"
  const val ACTION_DECLINE = "cord.ring.DECLINE"
  /** API < 26 only: setTimeoutAfter does nothing there, so an alarm ends the ring at expiry. */
  const val ACTION_EXPIRE = "cord.ring.EXPIRE"
  /** Set on the ring's activity intents so the activity can show over the lock screen at creation. */
  const val EXTRA_RING = "cord.ring"
  const val EXTRA_INVITE_ID = "invite_id"
  private const val NOTIFICATION_ID = 4712
  /** Longest a ring may last whatever the payload says. */
  private const val MAX_RING_MS = 120_000L
  /** Used when expires_at cannot be read. */
  private const val DEFAULT_RING_MS = 45_000L
  /** A decline older than this is useless: the invite has long been marked missed. */
  private const val DECLINE_TTL_MS = 30 * 60_000L
  private const val PREFS = "cord.ring"
  private const val KEY_ACCOUNT = "user_ref"
  private const val KEY_DECLINES = "pending_declines"
  /** Who rang, per invite id, so a later `missed` cancel (which carries neither) can say so. */
  private const val KEY_RINGS = "ring_meta"
  private const val RING_META_TTL_MS = 60 * 60_000L
  /** Invites already cancelled, missed or answered elsewhere, so a repeated sealed ring stays quiet. */
  private const val KEY_HANDLED = "handled_rings"
  const val MISSED_CHANNEL_ID = "cord_missed_call"
  private const val MISSED_NOTIFICATION_ID = 4713
  /** app.config.ts (plugins/withIncomingCalls.ts) writes the app's URL scheme here. */
  private const val SCHEME_META = "cord.ring.scheme"
  private const val TAG = "CordRing"

  @Volatile var listener: RingListener? = null

  fun account(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ACCOUNT, null)

  @Synchronized
  fun setAccount(context: Context, userRef: String?) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val changed = prefs.getString(KEY_ACCOUNT, null) != userRef
    val previous = if (changed) prunedRings(prefs.getString(KEY_RINGS, null)) else JSONObject()
    val edit = prefs.edit()
    if (userRef == null) edit.remove(KEY_ACCOUNT) else edit.putString(KEY_ACCOUNT, userRef)
    if (changed) edit.remove(KEY_RINGS)
    edit.commit() // The gate must see sign-out before the JS network request starts.
    if (changed) {
      for (id in previous.keys()) clear(context, id)
      clearMissed(context)
    }
  }

  /** Posts the ringing notification for a `cord.ring` data message. */
  fun show(context: Context, data: Map<String, String>) {
    val inviteId = data["invite_id"]?.takeIf { it.isNotBlank() && it.length <= 128 } ?: return
    val agentName = data["agent_name"]?.trim()?.take(80)?.ifEmpty { null } ?: "Your agent"
    val reason = data["reason"]?.trim()?.take(200) ?: ""
    val ringMs = remainingMs(data["expires_at"], data["server_time"])
    if (ringMs <= 0) return
    rememberRing(context, inviteId, data["agent_id"], agentName, reason)
    // With the app running, JS shows its incoming-call screen at once; the notification still
    // rings (the channel's sound) until answered, declined, cancelled, or expired.
    listener?.onRing(data)

    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    ensureChannel(manager)
    val caller = Person.Builder().setName(agentName).setImportant(true).build()
    val open = activityIntent(context, inviteId, answer = false)
    val answer = activityIntent(context, inviteId, answer = true)
    val decline = PendingIntent.getBroadcast(
      context,
      inviteId.hashCode(),
      Intent(context, RingDeclineReceiver::class.java)
        .setAction(ACTION_DECLINE)
        .putExtra(EXTRA_INVITE_ID, inviteId),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    fun base() = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_twring)
      .setContentTitle(agentName)
      .setContentText(reason)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_twring)
        .setContentTitle("Twring")
        .setContentText("Incoming call from your agent")
        .build())
      .setOngoing(true)
      .setAutoCancel(false)
      .setTimeoutAfter(ringMs)
      .setContentIntent(open)
      .setFullScreenIntent(open, true)
      // Pre-O devices have no channels: sound and vibration go on the notification itself.
      .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
      .setVibrate(VIBRATION)

    val callStyle = base()
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
      .addPerson(caller)
    if (!post(manager, inviteId, callStyle)) {
      // CallStyle can be refused (e.g. the full-screen intent was stripped): ring anyway, with
      // plain actions.
      post(
        manager,
        inviteId,
        base().addAction(0, "Decline", decline).addAction(0, "Answer", answer),
      )
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) scheduleExpiry(context, inviteId, ringMs)
  }

  /**
   * FLAG_INSISTENT rings until the notification goes; below API 26 nothing times it out, so a lost
   * `ring_cancel` push would ring forever. An inexact alarm clears it at expiry instead.
   */
  private fun scheduleExpiry(context: Context, inviteId: String, ringMs: Long) {
    val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val expire = PendingIntent.getBroadcast(
      context,
      inviteId.hashCode() * 2 + 1,
      Intent(context, RingDeclineReceiver::class.java)
        .setAction(ACTION_EXPIRE)
        .putExtra(EXTRA_INVITE_ID, inviteId),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    alarms.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + ringMs, expire)
  }

  /** Shows the activity over the lock screen and turns the screen on, or stops doing so. */
  fun showWhenLocked(activity: Activity, on: Boolean) {
    activity.runOnUiThread {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        activity.setShowWhenLocked(on)
        activity.setTurnScreenOn(on)
      } else {
        @Suppress("DEPRECATION")
        val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        if (on) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
      }
    }
  }

  /** Whether an activity intent came from a ring (full-screen intent, Answer, or tap). */
  fun isRingIntent(intent: Intent?): Boolean =
    intent != null && (intent.getBooleanExtra(EXTRA_RING, false) || intent.data?.host == "incoming")

  /** `cord.ring_cancel`, or an invite handled in the app: stop ringing. */
  fun cancel(context: Context, inviteId: String, status: String) {
    clear(context, inviteId)
    // Taken for every status, so a repeated `missed` push finds nothing and posts nothing twice.
    val meta = takeRing(context, inviteId)
    markHandled(context, inviteId)
    if (status == "missed" && meta != null) showMissed(context, inviteId, meta)
    listener?.onCancel(inviteId, status)
  }

  fun clear(context: Context, inviteId: String) {
    context.getSystemService(NotificationManager::class.java)?.cancel(inviteId, NOTIFICATION_ID)
  }

  /** Remembers a Decline tapped while JS may not be running; JS sends it (see docs/RINGING.md). */
  @Synchronized
  fun queueDecline(context: Context, inviteId: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val kept = JSONArray()
    val current = readDeclines(prefs.getString(KEY_DECLINES, null))
    for ((id, at) in current) {
      if (id != inviteId && now - at < DECLINE_TTL_MS) kept.put(JSONObject().put("id", id).put("at", at))
    }
    kept.put(JSONObject().put("id", inviteId).put("at", now))
    prefs.edit().putString(KEY_DECLINES, kept.toString()).apply()
  }

  /** The queued declines still worth sending; clears the queue. */
  @Synchronized
  fun takeDeclines(context: Context): List<String> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val ids = readDeclines(prefs.getString(KEY_DECLINES, null))
      .filter { (_, at) -> now - at < DECLINE_TTL_MS }
      .map { it.first }
    prefs.edit().remove(KEY_DECLINES).apply()
    return ids
  }

  private fun readDeclines(json: String?): List<Pair<String, Long>> {
    if (json == null) return emptyList()
    return try {
      val array = JSONArray(json)
      (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val id = item.optString("id").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        id to item.optLong("at")
      }
    } catch (_: Exception) {
      emptyList()
    }
  }

  private fun post(manager: NotificationManager, inviteId: String, builder: NotificationCompat.Builder): Boolean {
    return try {
      val notification = builder.build()
      // Keep ringing (sound and vibration repeat) until the notification goes away.
      notification.flags = notification.flags or Notification.FLAG_INSISTENT
      manager.notify(inviteId, NOTIFICATION_ID, notification)
      true
    } catch (error: Exception) {
      // SecurityException without POST_NOTIFICATIONS, IllegalArgumentException for a refused
      // CallStyle. Nothing secret in the message.
      Log.w(TAG, "ring notification refused: ${error.javaClass.simpleName}")
      false
    }
  }

  /** How long to ring: `expires_at - server_time`, so a phone clock that is off does not matter. */
  private fun remainingMs(expiresAt: String?, serverTime: String?): Long {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return DEFAULT_RING_MS
    return try {
      val expires = java.time.Instant.parse(expiresAt).toEpochMilli()
      val server = serverTime?.let { java.time.Instant.parse(it).toEpochMilli() } ?: System.currentTimeMillis()
      (expires - server).coerceAtMost(MAX_RING_MS)
    } catch (_: Exception) {
      DEFAULT_RING_MS
    }
  }

  private fun ensureChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Incoming agent calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Rings when one of your agents calls you"
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        enableVibration(true)
        vibrationPattern = VIBRATION
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      },
    )
  }

  /** Opens the app's /incoming/<id> route (Expo Router deep link); `answer` answers at once. */
  private fun activityIntent(context: Context, inviteId: String, answer: Boolean): PendingIntent {
    val scheme = scheme(context)
    val intent = if (scheme != null) {
      val query = if (answer) "?answer=1" else ""
      Intent(Intent.ACTION_VIEW, Uri.parse("$scheme://incoming/${Uri.encode(inviteId)}$query"))
        .setPackage(context.packageName)
    } else {
      // No scheme: open the app; it finds the pending invite itself.
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
    }
    intent.putExtra(EXTRA_RING, true)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      inviteId.hashCode() * 2 + if (answer) 1 else 0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  internal fun scheme(context: Context): String? = try {
    context.packageManager
      .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      .metaData?.getString(SCHEME_META)
  } catch (_: Exception) {
    null
  }

  /** Posts "Missed call from <agent>". A no-op when notifications are not allowed. */
  private fun showMissed(context: Context, inviteId: String, meta: JSONObject) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    ensureMissedChannel(manager)
    val agentName = meta.optString("name").ifEmpty { "Your agent" }
    val agentId = meta.optString("agent_id")
    val builder = NotificationCompat.Builder(context, MISSED_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_twring)
      .setContentTitle("Missed call from $agentName")
      .setContentText(meta.optString("reason"))
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(NotificationCompat.Builder(context, MISSED_CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_twring)
        .setContentTitle("Twring")
        .setContentText("Missed call from your agent")
        .build())
      .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setDefaults(NotificationCompat.DEFAULT_SOUND)
      .setAutoCancel(true)
      .setContentIntent(linkIntent(context, "history", inviteId.hashCode() * 4 + 2))
    if (AGENT_ID.matches(agentId)) {
      val query = "call_back=${Uri.encode(agentId)}&name=${Uri.encode(agentName)}"
      builder.addAction(0, "Call back", linkIntent(context, "history?$query", inviteId.hashCode() * 4 + 3))
    }
    try {
      manager.notify(inviteId, MISSED_NOTIFICATION_ID, builder.build())
    } catch (error: Exception) {
      Log.w(TAG, "missed-call notification refused: ${error.javaClass.simpleName}")
    }
  }

  /** Clears every missed-call notification (History or the Home missed card was opened). */
  fun clearMissed(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    try {
      manager.activeNotifications
        .filter { it.id == MISSED_NOTIFICATION_ID }
        .forEach { manager.cancel(it.tag, it.id) }
    } catch (_: Exception) {
    }
  }

  /** Opens `<scheme>://<path>` in the app, or just the app when no scheme is set. */
  internal fun linkIntent(context: Context, path: String, requestCode: Int): PendingIntent {
    val scheme = scheme(context)
    val intent = if (scheme != null) {
      Intent(Intent.ACTION_VIEW, Uri.parse("$scheme://$path")).setPackage(context.packageName)
    } else {
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun ensureMissedChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(MISSED_CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(MISSED_CHANNEL_ID, "Missed agent calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "When one of your agents called and nobody answered"
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      },
    )
  }

  @Synchronized
  private fun rememberRing(context: Context, inviteId: String, agentId: String?, name: String, reason: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val rings = prunedRings(prefs.getString(KEY_RINGS, null))
    rings.put(
      inviteId,
      JSONObject()
        .put("agent_id", agentId ?: "")
        .put("name", name)
        .put("reason", reason)
        .put("at", System.currentTimeMillis()),
    )
    prefs.edit().putString(KEY_RINGS, rings.toString()).apply()
  }

  @Synchronized
  private fun takeRing(context: Context, inviteId: String): JSONObject? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val rings = prunedRings(prefs.getString(KEY_RINGS, null))
    val meta = rings.optJSONObject(inviteId)
    rings.remove(inviteId)
    prefs.edit().putString(KEY_RINGS, rings.toString()).apply()
    return meta
  }

  /** True when this invite already rang or was handled: a relay repeat that must post nothing. */
  @Synchronized
  fun isRepeat(context: Context, inviteId: String): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return RingDedupe.isRepeat(
      inviteId,
      prunedRings(prefs.getString(KEY_RINGS, null)).keys().asSequence().toSet(),
      prunedRings(prefs.getString(KEY_HANDLED, null)).keys().asSequence().toSet(),
    )
  }

  @Synchronized
  private fun markHandled(context: Context, inviteId: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val handled = prunedRings(prefs.getString(KEY_HANDLED, null))
    handled.put(inviteId, JSONObject().put("at", System.currentTimeMillis()))
    prefs.edit().putString(KEY_HANDLED, handled.toString()).apply()
  }

  private fun prunedRings(json: String?): JSONObject {
    val kept = JSONObject()
    if (json == null) return kept
    try {
      val all = JSONObject(json)
      val now = System.currentTimeMillis()
      for (id in all.keys()) {
        val item = all.optJSONObject(id) ?: continue
        if (now - item.optLong("at") < RING_META_TTL_MS) kept.put(id, item)
      }
    } catch (_: Exception) {
    }
    return kept
  }

  internal val AGENT_ID = Regex("^agt_[a-z0-9]{20}$")
  private val VIBRATION = longArrayOf(0, 1000, 1000)
}
