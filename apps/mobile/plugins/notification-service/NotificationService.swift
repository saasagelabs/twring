import UserNotifications

/// Opens a sealed message push (C3 #10): Apple carries only the envelope and a fixed "New message"
/// alert; this shows the agent's name and first line again. Anything that does not open, and
/// running out of time, delivers the alert as sent. A message for an account not signed in here
/// shows only a neutral line (iOS shows an empty alert rather than none without Apple's filtering
/// entitlement). Never logs names, previews, keys or envelopes.
class NotificationService: UNNotificationServiceExtension {
  private static let maxTitle = 60
  private static let maxBody = 120

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    // A message for another account, or after sign-out, shows only a neutral line, never its text.
    let stored = CordAccountShare.stored()
    let info = request.content.userInfo
    if NotificationService.hidden(
      type: info["type"] as? String, pushRef: info["user_ref"] as? String, stored: stored)
    {
      let neutral = NotificationService.neutral(stored: stored)
      original = neutral
      deliver(neutral)
      return
    }
    original = request.content
    let content = NotificationService.opened(request.content, stored: stored) ?? request.content
    deliver(content)
  }

  /// A message push whose account is not the one signed in here (CordRingGate, as rings and
  /// Android do). A push without an account ref (older servers) or never-saved account shows.
  static func hidden(type: String?, pushRef: String?, stored: String?) -> Bool {
    guard type == "cord.message" else { return false }
    return !CordRingGate.shouldShow(stored: stored, pushRef: pushRef)
  }

  /// The alert for a message this phone may not show: no agent name, preview, sound or data, so a
  /// tap only opens the app.
  static func neutral(stored: String?) -> UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.body =
      (stored ?? "").isEmpty
      ? "Sign in to see your messages."
      : "New message for another Twring account."
    return content
  }

  override func serviceExtensionTimeWillExpire() {
    if let original { deliver(original) }
  }

  private func deliver(_ content: UNNotificationContent) {
    guard let handler = contentHandler else { return }
    contentHandler = nil
    handler(content)
  }

  /// The alert with the opened name and preview, or nil to leave it as sent. A relay push names
  /// its account only inside the envelope: one for another account comes back blank.
  static func opened(_ content: UNNotificationContent, stored: String?) -> UNNotificationContent? {
    guard let sealed = content.userInfo["sealed"] as? String else { return nil }
    guard
      let inner = CordSeal.open(
        keys: CordSealKeys.all(), data: ["kind": "message", "sealed": sealed], now: Date()),
      inner["type"] == "cord.message"
    else { return nil }
    if hidden(type: inner["type"], pushRef: inner["user_ref"], stored: stored) {
      return neutral(stored: stored)
    }
    guard let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return nil }
    let name = (inner["agent_name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    mutable.title = name.isEmpty ? "Your agent" : String(name.prefix(maxTitle))
    let preview = (inner["preview"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !preview.isEmpty { mutable.body = String(preview.prefix(maxBody)) }
    return mutable
  }
}
