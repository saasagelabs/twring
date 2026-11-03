package expo.modules.cordcallservice

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seal keys for self-hosted servers, one per server id, wrapped with an AndroidKeyStore AES-GCM
 * key. No user authentication, so a locked phone (after first unlock) can still open a ring.
 * Values are base64(iv || ciphertext) in SharedPreferences; keys are never logged.
 */
object SealKeys {
  private const val PREFS = "cord.seal"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val WRAP_ALIAS = "cord.seal.wrap"
  private const val IV_BYTES = 12
  private val SERVER_ID = Regex("^srv_[a-z2-7]{32}$")

  @Synchronized
  fun set(context: Context, serverId: String, keyB64url: String) {
    require(SERVER_ID.matches(serverId)) { "Invalid server id" }
    val key = Base64.decode(keyB64url, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    require(key.size == 32) { "Invalid seal key" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
    val stored = cipher.iv + cipher.doFinal(key)
    key.fill(0)
    prefs(context).edit().putString(serverId, Base64.encodeToString(stored, Base64.NO_WRAP)).commit()
  }

  @Synchronized
  fun remove(context: Context, serverId: String) {
    prefs(context).edit().remove(serverId).commit()
  }

  /** Every stored key that still unwraps; an entry that does not is skipped. */
  @Synchronized
  fun all(context: Context): List<ByteArray> {
    val entries = prefs(context).all.values.filterIsInstance<String>()
    if (entries.isEmpty()) return emptyList()
    val wrap = try {
      wrapKey()
    } catch (_: Exception) {
      return emptyList()
    }
    return entries.mapNotNull { value ->
      try {
        val stored = Base64.decode(value, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrap, GCMParameterSpec(128, stored, 0, IV_BYTES))
        cipher.doFinal(stored, IV_BYTES, stored.size - IV_BYTES)
      } catch (_: Exception) {
        null
      }
    }
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun wrapKey(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(false)
        .build(),
    )
    return generator.generateKey()
  }
}
