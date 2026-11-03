package expo.modules.cordcallservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/** One replaceable notification per agent for messages received while its chat is not in focus. */
object Messages {
  private const val CHANNEL_ID = "cord_agent_messages"
  private const val MESSAGE_NOTIFICATION_ID = 4714
  private const val TAG = "CordRing"

  fun show(context: Context, data: Map<String, String>) {
    val agentId = data["agent_id"]?.takeIf { Ring.AGENT_ID.matches(it) } ?: return
    data["message_id"]?.takeIf { it.isNotBlank() } ?: return
    val agentName = data["agent_name"]?.trim()?.take(60)?.ifEmpty { null } ?: "Your agent"
    val preview = data["preview"]?.trim()?.take(120) ?: ""
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    ensureChannel(manager)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_twring)
      .setContentTitle(agentName)
      .setContentText(preview)
      .setStyle(NotificationCompat.BigTextStyle().bigText(preview))
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_twring)
        .setContentTitle(agentName)
        .setContentText("New message")
        .build())
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setAutoCancel(true)
      .setGroup("twring.agent.$agentId")
      .setContentIntent(Ring.linkIntent(context, "chats/$agentId", agentId.hashCode()))
    if (data["silent"] == "1") builder.setSilent(true)
    else builder.setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
    try {
      manager.notify(agentId, MESSAGE_NOTIFICATION_ID, builder.build())
    } catch (error: Exception) {
      Log.w(TAG, "message notification refused: ${error.javaClass.simpleName}")
    }
  }

  fun clearMessages(context: Context, agentId: String) {
    if (!Ring.AGENT_ID.matches(agentId)) return
    context.getSystemService(NotificationManager::class.java)
      ?.cancel(agentId, MESSAGE_NOTIFICATION_ID)
  }

  private fun ensureChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Agent messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Messages from your agents"
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      },
    )
  }
}
