package expo.modules.cordcallservice

import com.google.crypto.tink.subtle.Base64
import com.google.crypto.tink.subtle.XChaCha20Poly1305
import org.json.JSONObject
import java.security.GeneralSecurityException
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Opens a `cord.sealed` push from a person's own server: the relay only sees the envelope
 * `{"v":1,"n":<nonce>,"c":<ciphertext+tag>}` (XChaCha20-Poly1305 with the server's seal key).
 * The inner push must match the outer kind and be fresh, so it can be neither relabelled nor
 * replayed. Never logs keys, envelopes or plaintext.
 */
object Sealed {
  private const val MAX_FUTURE_MS = 10 * 60_000L
  private const val MAX_RING_AGE_MS = 5 * 60_000L
  private const val MAX_AGE_MS = 24 * 60 * 60_000L
  private const val NONCE_BYTES = 24

  private val KIND_TYPES = mapOf(
    "ring" to "cord.ring",
    "ring_cancel" to "cord.ring_cancel",
    "missed_call" to "cord.ring_cancel",
    "message" to "cord.message",
  )

  /** The inner push as string fields, or null when nothing opens it or a check fails. */
  fun open(keys: List<ByteArray>, data: Map<String, String>, nowMs: Long): Map<String, String>? {
    val kind = data["kind"] ?: return null
    val expectedType = KIND_TYPES[kind] ?: return null
    val envelope = data["sealed"] ?: return null
    val plaintext = keys.firstNotNullOfOrNull { openEnvelope(it, envelope) } ?: return null
    val inner = try {
      JSONObject(String(plaintext, Charsets.UTF_8))
    } catch (_: Exception) {
      return null
    }
    if (inner.optString("kind") != kind) return null
    if (inner.optString("type") != expectedType) return null
    if (kind == "missed_call" && inner.optString("status") != "missed") return null
    val idField = if (kind == "message") "message_id" else "invite_id"
    val id = inner.optString("id")
    if (id.isEmpty() || id != inner.optString(idField)) return null
    val issuedAt = parseTime(inner.optString("issued_at")) ?: return null
    val maxAge = if (kind == "ring") MAX_RING_AGE_MS else MAX_AGE_MS
    if (issuedAt > nowMs + MAX_FUTURE_MS || nowMs - issuedAt > maxAge) return null

    val fields = HashMap<String, String>()
    for (name in inner.keys()) {
      when (val value = inner.opt(name)) {
        is String -> fields[name] = value
        is Number, is Boolean -> fields[name] = value.toString()
      }
    }
    return fields
  }

  /** Decrypts one envelope with one key; null for a wrong key, a bad shape or version. */
  internal fun openEnvelope(key: ByteArray, envelope: String): ByteArray? {
    return try {
      val json = JSONObject(envelope)
      if (json.opt("v") != 1) return null
      val nonce = Base64.urlSafeDecode(json.getString("n"))
      val ciphertext = Base64.urlSafeDecode(json.getString("c"))
      if (key.size != 32 || nonce.size != NONCE_BYTES) return null
      XChaCha20Poly1305(key).decrypt(nonce + ciphertext, ByteArray(0))
    } catch (_: GeneralSecurityException) {
      null
    } catch (_: Exception) {
      null
    }
  }

  /** The shared known-answer vector (packages/contracts/src/seal.test.ts). */
  fun selfTest(): Boolean {
    val key = "13a568b343a51c5e323095240586daf0f7f00890967bdfa12f02c2964c77ec26"
      .chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val envelope =
      """{"v":1,"n":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","c":"SGKLOEhsG4IEMFKN7GIsU2p5FaPYm8S2vokI98M39Jz4RUI"}"""
    val opened = openEnvelope(key, envelope) ?: return false
    return String(opened, Charsets.UTF_8) == "Twring known answer"
  }

  /** ISO 8601 UTC as `Date.toISOString()` writes it, with or without milliseconds. */
  private fun parseTime(value: String): Long? {
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX")) {
      val format = SimpleDateFormat(pattern, Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
        isLenient = false
      }
      val position = ParsePosition(0)
      val date = format.parse(value, position)
      if (date != null && position.index == value.length) return date.time
    }
    return null
  }
}

/** Pure check: the relay can deliver a ring twice; a repeat must post nothing new. */
object RingDedupe {
  fun isRepeat(inviteId: String, ringing: Set<String>, handled: Set<String>): Boolean =
    inviteId in ringing || inviteId in handled
}
