import Foundation

/// Pure account check before a ring shows (the Android side is RingGate.kt). `stored` is nil when
/// nothing was ever saved (an update that has not opened yet): the ring rings, as before. An empty
/// value is the signed-out marker: no ring. Otherwise only a ring for that account rings; a push
/// without an account ref (older servers) rings whoever is signed in.
enum CordRingGate {
  static func shouldShow(stored: String?, pushRef: String?) -> Bool {
    guard let stored else { return true }
    guard !stored.isEmpty else { return false }
    return pushRef == nil || pushRef == stored
  }
}
