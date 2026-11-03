package expo.modules.cordcallservice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Decline on the ringing notification. Stops the ring at once and queues the decline; JS sends
 * `POST /v1/invites/:id/decline` now if it is running, otherwise on next launch. No sign-in token
 * is ever stored natively for this. Below API 26 it also takes the ring's expiry alarm (Ring.kt).
 */
class RingDeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val inviteId = intent.getStringExtra(Ring.EXTRA_INVITE_ID)?.takeIf { it.isNotBlank() } ?: return
    if (intent.action == Ring.ACTION_EXPIRE) {
      // Only the ringing stops; JS learns the invite's fate from the gateway as usual.
      Ring.clear(context, inviteId)
      return
    }
    if (intent.action != Ring.ACTION_DECLINE) return
    Ring.clear(context, inviteId)
    Ring.queueDecline(context, inviteId)
    Ring.listener?.onDeclined(inviteId)
  }
}
