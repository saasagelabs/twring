package expo.modules.cordcallservice

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import android.util.Log

/**
 * The app's only FirebaseMessagingService. FCM data messages reach it even when the app was
 * killed, which a JS handler cannot guarantee; it only shows or clears the ring (Ring.kt).
 */
class RingMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] == "cord.sealed") {
      // From a person's own server: only the inner fields go on, never the outer ones.
      val inner = Sealed.open(SealKeys.all(applicationContext), data, System.currentTimeMillis())
      if (inner == null) {
        Log.d("CordRing", "sealed push dropped")
        return
      }
      dispatch(inner)
      return
    }
    dispatch(data)
  }

  private fun dispatch(data: Map<String, String>) {
    when (data["type"]) {
      "cord.ring" -> {
        // FCM can deliver a ring twice, or late after its cancel: a repeat of an invite that
        // already rang, was answered or was cancelled must not ring again (hosted and sealed).
        val inviteId = data["invite_id"]
        if (inviteId != null && Ring.isRepeat(applicationContext, inviteId)) {
          Log.d("CordRing", "repeated ring dropped")
          return
        }
        if (RingGate.shouldShow(Ring.account(applicationContext), data["user_ref"])) {
          Ring.show(applicationContext, data)
        } else {
          Log.d("CordRing", "ring dropped for account")
        }
      }
      "cord.message" -> {
        if (RingGate.shouldShow(Ring.account(applicationContext), data["user_ref"])) {
          Messages.show(applicationContext, data)
        } else {
          Log.d("CordRing", "message dropped for account")
        }
      }
      "cord.ring_cancel" -> {
        val inviteId = data["invite_id"]?.takeIf { it.isNotBlank() } ?: return
        Ring.cancel(applicationContext, inviteId, data["status"] ?: "cancelled")
      }
    }
  }

  /** JS re-registers the token; without a JS runtime it reads the new token on next launch. */
  override fun onNewToken(token: String) {
    Ring.listener?.onToken(token)
  }
}
