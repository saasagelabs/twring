import Foundation

/// Pure account check before a ring shows (the Android side is RingGate.kt): only a ring for the
/// signed-in account rings. A push without an account ref (older servers) rings whoever is signed in.
enum CordRingGate {
  static func shouldShow(stored: String?, pushRef: String?) -> Bool {
    guard let stored, !stored.isEmpty else { return false }
    return pushRef == nil || pushRef == stored
  }
}
