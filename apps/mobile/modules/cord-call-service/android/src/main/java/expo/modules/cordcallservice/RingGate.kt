package expo.modules.cordcallservice

/** Pure account check used before any ring content reaches a notification or JS. */
object RingGate {
  fun shouldShow(stored: String?, pushRef: String?): Boolean =
    stored != null && (pushRef == null || pushRef == stored)
}
