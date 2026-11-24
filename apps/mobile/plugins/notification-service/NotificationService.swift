import UserNotifications

/// Opens a sealed message push (C3 #10): Apple carries only the envelope and a fixed "New message"
/// alert; this shows the agent's name and first line again. Anything that does not open, and
/// running out of time, delivers the alert as sent. Never logs names, previews, keys or envelopes.
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
    original = request.content
    let content = NotificationService.opened(request.content) ?? request.content
    deliver(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let original { deliver(original) }
  }

  private func deliver(_ content: UNNotificationContent) {
    guard let handler = contentHandler else { return }
    contentHandler = nil
    handler(content)
  }

  /// The alert with the opened name and preview, or nil to leave it as sent.
  static func opened(_ content: UNNotificationContent) -> UNNotificationContent? {
    guard let sealed = content.userInfo["sealed"] as? String else { return nil }
    guard
      let inner = CordSeal.open(
        keys: CordSealKeys.all(), data: ["kind": "message", "sealed": sealed], now: Date()),
      inner["type"] == "cord.message"
    else { return nil }
    guard let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return nil }
    let name = (inner["agent_name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    mutable.title = name.isEmpty ? "Your agent" : String(name.prefix(maxTitle))
    let preview = (inner["preview"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !preview.isEmpty { mutable.body = String(preview.prefix(maxBody)) }
    return mutable
  }
}
