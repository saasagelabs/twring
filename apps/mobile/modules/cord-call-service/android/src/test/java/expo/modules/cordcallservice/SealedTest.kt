package expo.modules.cordcallservice

import com.google.crypto.tink.subtle.Base64
import com.google.crypto.tink.subtle.Random
import com.google.crypto.tink.subtle.XChaCha20Poly1305
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SealedTest {
  private val now = Instant.parse("2026-10-31T12:00:00Z").toEpochMilli()
  private val key = Random.randBytes(32)

  private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  private fun b64(bytes: ByteArray) = Base64.urlSafeEncode(bytes).trimEnd('=')

  private fun ring(issuedAt: Long = now, id: String = "inv_1"): JSONObject =
    JSONObject()
      .put("type", "cord.ring")
      .put("invite_id", "inv_1")
      .put("agent_name", "Ada")
      .put("ring_seconds", 45)
      .put("kind", "ring")
      .put("id", id)
      .put("issued_at", Instant.ofEpochMilli(issuedAt).toString())

  private fun seal(inner: JSONObject, sealKey: ByteArray = key, v: Int = 1): String {
    val out = XChaCha20Poly1305(sealKey).encrypt(inner.toString().toByteArray(), ByteArray(0))
    val nonce = out.copyOfRange(0, 24)
    val ciphertext = out.copyOfRange(24, out.size)
    return JSONObject().put("v", v).put("n", b64(nonce)).put("c", b64(ciphertext)).toString()
  }

  private fun outer(kind: String, sealed: String) =
    mapOf("type" to "cord.sealed", "kind" to kind, "sealed" to sealed)

  @Test
  fun knownAnswerVectorOpens() {
    val envelope =
      """{"v":1,"n":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","c":"SGKLOEhsG4IEMFKN7GIsU2p5FaPYm8S2vokI98M39Jz4RUI"}"""
    val key = hex("13a568b343a51c5e323095240586daf0f7f00890967bdfa12f02c2964c77ec26")
    assertEquals("Twring known answer", Sealed.openEnvelope(key, envelope)?.let { String(it) })
    assertEquals(
      "000102030405060708090a0b0c0d0e0f1011121314151617".length / 2,
      Base64.urlSafeDecode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYX").size,
    )
  }

  @Test
  fun selfTestPasses() {
    assertTrue(Sealed.selfTest())
  }

  @Test
  fun validRingOpensWithInnerFieldsOnly() {
    val inner = Sealed.open(listOf(key), outer("ring", seal(ring())), now)!!
    assertEquals("cord.ring", inner["type"])
    assertEquals("inv_1", inner["invite_id"])
    assertEquals("45", inner["ring_seconds"])
    assertNull(inner["sealed"])
  }

  @Test
  fun secondKeyOpens() {
    assertEquals("inv_1", Sealed.open(listOf(Random.randBytes(32), key), outer("ring", seal(ring())), now)?.get("invite_id"))
  }

  @Test
  fun flippedByteFails() {
    val env = JSONObject(seal(ring()))
    val c = Base64.urlSafeDecode(env.getString("c"))
    c[3] = (c[3].toInt() xor 1).toByte()
    env.put("c", b64(c))
    assertNull(Sealed.open(listOf(key), outer("ring", env.toString()), now))
  }

  @Test
  fun wrongKeyFails() {
    assertNull(Sealed.open(listOf(Random.randBytes(32)), outer("ring", seal(ring())), now))
  }

  @Test
  fun versionTwoFails() {
    assertNull(Sealed.open(listOf(key), outer("ring", seal(ring(), v = 2)), now))
  }

  @Test
  fun relabelledKindFails() {
    assertNull(Sealed.open(listOf(key), outer("message", seal(ring())), now))
  }

  @Test
  fun idMismatchFails() {
    assertNull(Sealed.open(listOf(key), outer("ring", seal(ring(id = "inv_2"))), now))
  }

  @Test
  fun staleRingFails() {
    assertNull(Sealed.open(listOf(key), outer("ring", seal(ring(issuedAt = now - 6 * 60_000L))), now))
  }

  @Test
  fun futureRingFails() {
    assertNull(Sealed.open(listOf(key), outer("ring", seal(ring(issuedAt = now + 11 * 60_000L))), now))
  }

  @Test
  fun dayOldMessageOpens() {
    val msg = JSONObject()
      .put("type", "cord.message")
      .put("message_id", "msg_1")
      .put("preview", "hi")
      .put("kind", "message")
      .put("id", "msg_1")
      .put("issued_at", Instant.ofEpochMilli(now - 23 * 3_600_000L).toString())
    assertEquals("msg_1", Sealed.open(listOf(key), outer("message", seal(msg)), now)?.get("message_id"))
  }

  @Test
  fun missedCallNeedsMissedStatus() {
    fun missed(status: String) = JSONObject()
      .put("type", "cord.ring_cancel")
      .put("invite_id", "inv_1")
      .put("status", status)
      .put("kind", "missed_call")
      .put("id", "inv_1")
      .put("issued_at", Instant.ofEpochMilli(now).toString())
    assertEquals("missed", Sealed.open(listOf(key), outer("missed_call", seal(missed("missed"))), now)?.get("status"))
    assertNull(Sealed.open(listOf(key), outer("missed_call", seal(missed("cancelled"))), now))
  }

  @Test
  fun repeatedRingPostsNothingNew() {
    assertFalse(RingDedupe.isRepeat("inv_1", ringing = emptySet(), handled = emptySet()))
    assertTrue(RingDedupe.isRepeat("inv_1", ringing = setOf("inv_1"), handled = emptySet()))
    assertTrue(RingDedupe.isRepeat("inv_1", ringing = emptySet(), handled = setOf("inv_1")))
  }
}
