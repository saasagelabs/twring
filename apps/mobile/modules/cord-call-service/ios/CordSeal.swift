import CryptoKit
import Foundation
import Security

/// Opens a `cord.sealed` push from a person's own server: the relay only sees the envelope
/// `{"v":1,"n":<nonce>,"c":<ciphertext+tag>}` (XChaCha20-Poly1305 with the server's seal key).
/// The inner push must match the outer kind and be fresh, so it can be neither relabelled nor
/// replayed. Mirrors Sealed.kt on Android check for check. Never logs keys, envelopes or plaintext.
enum CordSeal {
  private static let maxFuture: TimeInterval = 10 * 60
  private static let maxRingAge: TimeInterval = 5 * 60
  private static let maxAge: TimeInterval = 24 * 60 * 60
  private static let nonceBytes = 24

  private static let kindTypes: [String: String] = [
    "ring": "cord.ring",
    "ring_cancel": "cord.ring_cancel",
    "missed_call": "cord.ring_cancel",
    "message": "cord.message",
  ]

  /// The inner push as string fields, or nil when nothing opens it or a check fails.
  static func open(keys: [[UInt8]], data: [String: Any], now: Date) -> [String: String]? {
    guard let kind = data["kind"] as? String else { return nil }
    guard let expectedType = kindTypes[kind] else { return nil }
    guard let envelope = data["sealed"] as? String else { return nil }
    guard let plaintext = keys.lazy.compactMap({ openEnvelope(key: $0, envelope: envelope) }).first
    else { return nil }
    guard let parsed = try? JSONSerialization.jsonObject(with: plaintext),
      let inner = parsed as? [String: Any]
    else { return nil }
    if text(inner["kind"]) != kind { return nil }
    if text(inner["type"]) != expectedType { return nil }
    if kind == "missed_call" && text(inner["status"]) != "missed" { return nil }
    let idField = kind == "message" ? "message_id" : "invite_id"
    let id = text(inner["id"])
    if id.isEmpty || id != text(inner[idField]) { return nil }
    guard let issuedAt = parseTime(text(inner["issued_at"])) else { return nil }
    let age = kind == "ring" ? maxRingAge : maxAge
    let nowSeconds = now.timeIntervalSince1970
    let issued = issuedAt.timeIntervalSince1970
    if issued > nowSeconds + maxFuture || nowSeconds - issued > age { return nil }

    var fields: [String: String] = [:]
    for (name, value) in inner {
      if let value = value as? String {
        fields[name] = value
      } else if let value = value as? NSNumber {
        fields[name] = isBool(value) ? (value.boolValue ? "true" : "false") : value.stringValue
      }
    }
    return fields
  }

  /// Decrypts one envelope with one key; nil for a wrong key, a bad shape or version.
  static func openEnvelope(key: [UInt8], envelope: String) -> Data? {
    guard let raw = envelope.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: raw),
      let json = parsed as? [String: Any]
    else { return nil }
    guard let v = json["v"] as? NSNumber, !isBool(v), v.stringValue == "1" else { return nil }
    guard let n = json["n"] as? String, let c = json["c"] as? String,
      let nonce = base64url(n), let ciphertext = base64url(c)
    else { return nil }
    if key.count != 32 || nonce.count != nonceBytes { return nil }
    return decrypt(key: key, nonce: nonce, ciphertext: ciphertext)
  }

  /// The shared known-answer vector (packages/contracts/src/seal.test.ts).
  static func selfTest() -> Bool {
    let hex = "13a568b343a51c5e323095240586daf0f7f00890967bdfa12f02c2964c77ec26"
    var key: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return false }
      key.append(byte)
      index = next
    }
    let envelope =
      #"{"v":1,"n":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","c":"SGKLOEhsG4IEMFKN7GIsU2p5FaPYm8S2vokI98M39Jz4RUI"}"#
    guard let opened = openEnvelope(key: key, envelope: envelope) else { return false }
    return String(data: opened, encoding: .utf8) == "Twring known answer"
  }

  /// HChaCha20 (draft-irtf-cfrg-xchacha 2.2): the XChaCha20 subkey for the first 16 nonce bytes.
  static func hchacha20(key: [UInt8], nonce16: [UInt8]) -> [UInt8] {
    func word(_ b: [UInt8], _ i: Int) -> UInt32 {
      UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
    }
    var s: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]
    for i in 0..<8 { s.append(word(key, i * 4)) }
    for i in 0..<4 { s.append(word(nonce16, i * 4)) }
    func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 { (v << n) | (v >> (32 - n)) }
    func qr(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
      s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 16)
      s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 12)
      s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 8)
      s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 7)
    }
    for _ in 0..<10 {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
    }
    var out: [UInt8] = []
    for i in [0, 1, 2, 3, 12, 13, 14, 15] {
      let v = s[i]
      out += [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8(v >> 24)]
    }
    return out
  }

  /// XChaCha20-Poly1305 open: nil for a wrong key or any changed byte.
  static func decrypt(key: [UInt8], nonce: [UInt8], ciphertext: [UInt8]) -> Data? {
    guard key.count == 32, nonce.count == 24, ciphertext.count >= 16 else { return nil }
    let subkey = SymmetricKey(data: hchacha20(key: key, nonce16: Array(nonce[0..<16])))
    guard let chachaNonce = try? ChaChaPoly.Nonce(data: [0, 0, 0, 0] + Array(nonce[16..<24])),
      let box = try? ChaChaPoly.SealedBox(
        nonce: chachaNonce,
        ciphertext: ciphertext[0..<(ciphertext.count - 16)],
        tag: ciphertext[(ciphertext.count - 16)...])
    else { return nil }
    return try? ChaChaPoly.open(box, using: subkey)
  }

  /// Base64url with or without padding; nil for anything else.
  static func base64url(_ value: String) -> [UInt8]? {
    var text = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while text.count % 4 != 0 { text += "=" }
    return Data(base64Encoded: text).map { [UInt8]($0) }
  }

  /// A JSON value as `optString` reads it on Android: strings as they are, numbers as text.
  private static func text(_ value: Any?) -> String {
    if let value = value as? String { return value }
    if let value = value as? NSNumber {
      return isBool(value) ? (value.boolValue ? "true" : "false") : value.stringValue
    }
    return ""
  }

  private static func isBool(_ value: NSNumber) -> Bool {
    CFGetTypeID(value) == CFBooleanGetTypeID()
  }

  /// ISO 8601 UTC as `Date.toISOString()` writes it, with or without milliseconds.
  private static func parseTime(_ value: String) -> Date? {
    let withMillis = ISO8601DateFormatter()
    withMillis.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withMillis.date(from: value) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
  }
}

/// Seal keys for self-hosted servers, one per server id, in the Keychain. Readable after first
/// unlock (a locked phone can still open a ring), this device only, never synced. Never logged.
enum CordSealKeys {
  private static let service = "com.twring.seal"
  private static let lock = NSLock()

  enum Failure: Error {
    case invalidServerId
    case invalidKey
    case keychain(OSStatus)
  }

  static func isServerId(_ value: String) -> Bool {
    value.range(of: "^srv_[a-z2-7]{32}$", options: .regularExpression) != nil
  }

  static func set(serverId: String, keyB64url: String) throws {
    guard isServerId(serverId) else { throw Failure.invalidServerId }
    guard !keyB64url.contains("="), let key = CordSeal.base64url(keyB64url), key.count == 32
    else { throw Failure.invalidKey }
    lock.lock()
    defer { lock.unlock() }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: serverId,
    ]
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = Data(key)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    add[kSecAttrSynchronizable as String] = kCFBooleanFalse
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw Failure.keychain(status) }
  }

  static func remove(serverId: String) {
    lock.lock()
    defer { lock.unlock() }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: serverId,
    ]
    SecItemDelete(query as CFDictionary)
  }

  /// Every stored 32-byte key; an entry that is not one is skipped.
  static func all() -> [[UInt8]] {
    lock.lock()
    defer { lock.unlock() }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let items = result as? [Data]
    else { return [] }
    return items.map { [UInt8]($0) }.filter { $0.count == 32 }
  }
}

/// Invites already rung within the last hour: the relay can deliver a ring twice, and a repeat
/// must ring nothing new (Android's handled set in Ring.kt). Invite ids are not secrets.
enum CordRingDedupe {
  private static let key = "cord.ring.handled"
  private static let ttl: TimeInterval = 60 * 60
  private static let lock = NSLock()

  static func isHandled(_ inviteId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return pruned()[inviteId] != nil
  }

  static func markHandled(_ inviteId: String) {
    lock.lock()
    defer { lock.unlock() }
    var handled = pruned()
    handled[inviteId] = Date().timeIntervalSince1970
    UserDefaults.standard.set(handled, forKey: key)
  }

  private static func pruned() -> [String: Double] {
    let all = UserDefaults.standard.dictionary(forKey: key) as? [String: Double] ?? [:]
    let now = Date().timeIntervalSince1970
    return all.filter { now - $0.value < ttl }
  }
}
