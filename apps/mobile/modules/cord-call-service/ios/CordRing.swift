import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit
import UserNotifications

/// Incoming agent calls on iOS.
///
/// A ring arrives as a PushKit VoIP push and is shown with CallKit at once: Apple requires every
/// VoIP push to report an incoming call, or it stops delivering them. Answer, decline, hang-up and
/// mute from the system call screen are passed to JS; JS runs the existing answer flow. Messages and
/// missed rings are ordinary alerts. Created at app launch (CordRingAppDelegateSubscriber), so a
/// push that wakes the app is handled before any JS runs.
final class CordRing: NSObject, PKPushRegistryDelegate, CXProviderDelegate,
  UNUserNotificationCenterDelegate, AVAudioPlayerDelegate
{
  static let shared = CordRing()

  private struct Ring {
    let inviteId: String
    let payload: [String: Any]
    var answered: Bool
  }

  private static let declinesKey = "cord.ring.pending_declines"
  private static let missedThread = "missed-calls"

  private let provider: CXProvider
  private let calls = CXCallController()
  private var registry: PKPushRegistry?
  /// Guards everything JS reads or takes from its own thread.
  private let lock = NSLock()

  // Main-thread state.
  private var rings: [UUID: Ring] = [:]
  private var timers: [UUID: Timer] = [:]

  // Shared with the JS thread (under `lock`).
  private var voipToken: String?
  private var alertToken: String?
  private var alertsAllowed = false
  private var answered: [String: Any]?
  private var opened: [String: Any]?
  private var emitter: ((String, [String: Any]) -> Void)?

  override init() {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  /// At app launch: PushKit, the notification delegate and the alert token.
  func start() {
    guard registry == nil else { return }
    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
    UNUserNotificationCenter.current().delegate = self
    refreshAlertStatus()
    UIApplication.shared.registerForRemoteNotifications()
  }

  // MARK: JS bridge

  func setEmitter(_ emit: ((String, [String: Any]) -> Void)?) {
    lock.withLock { emitter = emit }
  }

  private func emit(_ name: String, _ body: [String: Any] = [:]) {
    let send = lock.withLock { emitter }
    send?(name, body)
  }

  var currentVoipToken: String? { lock.withLock { voipToken } }
  var currentAlertToken: String? { lock.withLock { alertToken } }
  var currentAlertsAllowed: Bool { lock.withLock { alertsAllowed } }

  /// The ring answered on the system call screen, once (also after a cold start).
  func takeAnswered() -> [String: Any]? {
    lock.withLock {
      defer { answered = nil }
      return answered
    }
  }

  /// The notification the user tapped, once.
  func takeOpened() -> [String: Any]? {
    lock.withLock {
      defer { opened = nil }
      return opened
    }
  }

  func queueDecline(_ inviteId: String) {
    lock.withLock {
      var list = UserDefaults.standard.stringArray(forKey: Self.declinesKey) ?? []
      if !list.contains(inviteId) { list.append(inviteId) }
      UserDefaults.standard.set(list, forKey: Self.declinesKey)
    }
  }

  func takeDeclines() -> [String] {
    lock.withLock {
      let list = UserDefaults.standard.stringArray(forKey: Self.declinesKey) ?? []
      UserDefaults.standard.removeObject(forKey: Self.declinesKey)
      return list
    }
  }

  func requestAlerts(_ done: @escaping (Bool) -> Void) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
      granted, _ in
      self.lock.withLock { self.alertsAllowed = granted }
      DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
        done(granted)
      }
    }
  }

  func refreshAlertStatus() {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let allowing: [UNAuthorizationStatus] = [.authorized, .provisional, .ephemeral]
      let allowed = allowing.contains(settings.authorizationStatus)
      self.lock.withLock { self.alertsAllowed = allowed }
    }
  }

  func alertTokenArrived(_ token: Data) {
    let hex = token.map { String(format: "%02x", $0) }.joined()
    lock.withLock { alertToken = hex }
    emit("onAlertToken", ["token": hex])
  }

  /// The app's own call ended: close the system call too.
  func endActiveCall() {
    DispatchQueue.main.async {
      for (uuid, ring) in self.rings where ring.answered {
        self.calls.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
      }
    }
  }

  /// The app's mute changed: keep the system call screen in step.
  func setMuted(_ muted: Bool) {
    DispatchQueue.main.async {
      for (uuid, ring) in self.rings where ring.answered {
        self.calls.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) {
          _ in
        }
      }
    }
  }

  /// The ring ended elsewhere (answered on another phone, cancelled, missed, or answered in the app):
  /// close a call screen that is still ringing. An answered call is left alone.
  func ringEnded(inviteId: String) {
    DispatchQueue.main.async {
      for (uuid, ring) in self.rings where ring.inviteId == inviteId && !ring.answered {
        self.rings[uuid] = nil
        self.timers.removeValue(forKey: uuid)?.invalidate()
        self.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
      }
    }
  }

  func removeDelivered(thread: String) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ids = delivered
        .filter { $0.request.content.threadIdentifier == thread }
        .map { $0.request.identifier }
      center.removeDeliveredNotifications(withIdentifiers: ids)
    }
  }

  func removeMissedCalls() {
    removeDelivered(thread: Self.missedThread)
  }

  /// A plain local notification, shown at once: why an answered ring could not connect.
  func notify(title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(
      identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }

  /// A background push: a ring that ended elsewhere closes its call screen.
  func backgroundPush(_ userInfo: [AnyHashable: Any]) {
    if userInfo["type"] as? String == "cord.sealed" {
      // From a person's own server: only a cancel or missed ring is acted on here.
      let data = Self.stringKeyed(userInfo)
      let kind = data["kind"] as? String
      guard kind == "ring_cancel" || kind == "missed_call" else { return }
      guard let inner = CordSeal.open(keys: CordSealKeys.all(), data: data, now: Date()),
        let id = inner["invite_id"]
      else {
        NSLog("CordRing: sealed push dropped")
        return
      }
      CordRingDedupe.markHandled(id)
      ringEnded(inviteId: id)
      return
    }
    if userInfo["type"] as? String == "cord.ring_cancel", let id = userInfo["invite_id"] as? String {
      ringEnded(inviteId: id)
    }
  }

  // MARK: Spoken message

  /// An AI app's ring opens its chat, not a call. On the system call screen the message is read
  /// out first, then the call ends by itself: the phone may be locked, and nothing else would
  /// answer the person holding it to their ear.
  private var speech: AVAudioPlayer?
  private var pendingSpeech: AVAudioPlayer?
  private var audioActive = false
  private var speechLimit: Timer?

  func speakThenEnd(url: URL, headers: [String: String]) {
    var request = URLRequest(url: url, timeoutInterval: 15)
    headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
    URLSession.shared.dataTask(with: request) { data, response, _ in
      DispatchQueue.main.async {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        guard ok, let data, let player = try? AVAudioPlayer(data: data),
          self.rings.values.contains(where: { $0.answered })
        else {
          self.endActiveCall()
          return
        }
        player.delegate = self
        if self.audioActive {
          self.play(player)
        } else {
          self.pendingSpeech = player
        }
      }
    }.resume()
  }

  private func play(_ player: AVAudioPlayer) {
    speech = player
    guard player.play() else {
      stopSpeech()
      endActiveCall()
      return
    }
    // A stuck player never keeps the call open.
    speechLimit = Timer.scheduledTimer(
      withTimeInterval: min(120, player.duration + 5), repeats: false
    ) { [weak self] _ in
      self?.stopSpeech()
      self?.endActiveCall()
    }
  }

  private func stopSpeech() {
    speechLimit?.invalidate()
    speechLimit = nil
    speech?.stop()
    speech = nil
    pendingSpeech = nil
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    guard player === speech else { return }
    stopSpeech()
    endActiveCall()
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    guard player === speech else { return }
    stopSpeech()
    endActiveCall()
  }

  // MARK: Live call

  private var audioObservers: [NSObjectProtocol] = []

  /// While a call is live: the screen goes off at the ear (proximity sensor), and audio route
  /// changes and interruptions are reported so a call that goes quiet can be diagnosed.
  func setCallActive(_ active: Bool) {
    DispatchQueue.main.async {
      UIDevice.current.isProximityMonitoringEnabled = active
      self.audioObservers.forEach { NotificationCenter.default.removeObserver($0) }
      self.audioObservers = []
      guard active else { return }
      let center = NotificationCenter.default
      self.audioObservers.append(
        center.addObserver(
          forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
          let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
          let session = AVAudioSession.sharedInstance()
          self?.emit(
            "onAudioEvent",
            [
              "kind": "route",
              "reason": Self.routeReason(raw),
              "output": session.currentRoute.outputs.first?.portType.rawValue ?? "none",
              "category": session.category.rawValue,
              "mode": session.mode.rawValue,
            ])
        })
      self.audioObservers.append(
        center.addObserver(
          forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
          let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
          self?.emit(
            "onAudioEvent",
            ["kind": "interruption", "reason": raw == 1 ? "began" : "ended"])
        })
    }
  }

  private static func routeReason(_ raw: UInt) -> String {
    switch AVAudioSession.RouteChangeReason(rawValue: raw) {
    case .newDeviceAvailable: return "new_device"
    case .oldDeviceUnavailable: return "device_gone"
    case .categoryChange: return "category_change"
    case .override: return "override"
    case .wakeFromSleep: return "wake"
    case .noSuitableRouteForCategory: return "no_route"
    case .routeConfigurationChange: return "configuration"
    default: return "unknown"
    }
  }

  // MARK: PushKit

  func pushRegistry(
    _ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType
  ) {
    let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
    lock.withLock { voipToken = hex }
    emit("onPushToken", ["token": hex])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    lock.withLock { voipToken = nil }
  }

  func pushRegistry(
    _ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType, completion: @escaping () -> Void
  ) {
    reportRing(payload.dictionaryPayload, completion: completion)
  }

  private static func stringKeyed(_ raw: [AnyHashable: Any]) -> [String: Any] {
    var payload: [String: Any] = [:]
    for (key, value) in raw {
      if let key = key as? String { payload[key] = value }
    }
    return payload
  }

  private func reportRing(_ raw: [AnyHashable: Any], completion: @escaping () -> Void) {
    var payload = Self.stringKeyed(raw)
    var sealedFailed = false
    if payload["type"] as? String == "cord.sealed" {
      // From a person's own server: only the inner fields go on, never the outer ones. A sealed
      // push that does not open as a ring still needs its reported call, ended at once below.
      if payload["kind"] as? String == "ring",
        let inner = CordSeal.open(keys: CordSealKeys.all(), data: payload, now: Date())
      {
        payload = inner
      } else {
        NSLog("CordRing: sealed push dropped")
        payload = [:]
        sealedFailed = true
      }
    }
    let inviteId = payload["invite_id"] as? String ?? ""
    let name = (payload["agent_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Twring"
    let duplicate =
      rings.values.contains { $0.inviteId == inviteId }
      || (!inviteId.isEmpty && CordRingDedupe.isHandled(inviteId))
    let busy = rings.values.contains { $0.answered }
    let uuid = UUID()
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: name)
    update.localizedCallerName = name
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    // Apple requires a reported call for every VoIP push, even one we cannot use; such a call is
    // ended at once.
    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      defer { completion() }
      guard let self, error == nil else { return }
      if sealedFailed || inviteId.isEmpty || duplicate || busy {
        self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
        return
      }
      CordRingDedupe.markHandled(inviteId)
      self.rings[uuid] = Ring(inviteId: inviteId, payload: payload, answered: false)
      self.timers[uuid] = Timer.scheduledTimer(
        withTimeInterval: Self.ringSeconds(payload), repeats: false
      ) { [weak self] _ in
        self?.expire(uuid)
      }
    }
  }

  /// How long the ring lasts: the server's own window, so a wrong phone clock does not matter.
  static func ringSeconds(_ payload: [String: Any]) -> TimeInterval {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = { (key: String) in (payload[key] as? String).flatMap { format.date(from: $0) } }
    guard let expires = date("expires_at"), let now = date("server_time") else { return 30 }
    return min(60, max(5, expires.timeIntervalSince(now)))
  }

  private func expire(_ uuid: UUID) {
    timers[uuid] = nil
    guard let ring = rings[uuid], !ring.answered else { return }
    rings[uuid] = nil
    provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
  }

  // MARK: CallKit

  func providerDidReset(_ provider: CXProvider) {
    stopSpeech()
    let hadCall = rings.values.contains { $0.answered }
    timers.values.forEach { $0.invalidate() }
    timers.removeAll()
    rings.removeAll()
    if hadCall { emit("onCallEnded") }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard var ring = rings[action.callUUID] else {
      action.fail()
      return
    }
    ring.answered = true
    rings[action.callUUID] = ring
    timers.removeValue(forKey: action.callUUID)?.invalidate()
    // Apple's order: set the audio up here, start it once the system activates the session.
    try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat)
    lock.withLock { answered = ring.payload }
    emit("onRingAnswered", ["invite_id": ring.inviteId])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    timers.removeValue(forKey: action.callUUID)?.invalidate()
    stopSpeech()
    if let ring = rings.removeValue(forKey: action.callUUID) {
      if ring.answered {
        emit("onCallEnded")
      } else {
        queueDecline(ring.inviteId)
        emit("onRingDeclined", ["invite_id": ring.inviteId])
      }
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    emit("onCallMuted", ["muted": action.isMuted])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    audioActive = true
    if let player = pendingSpeech {
      pendingSpeech = nil
      play(player)
    }
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    audioActive = false
  }

  // MARK: Notifications

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    backgroundPush(notification.request.content.userInfo)
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    var data: [String: Any] = [:]
    for (key, value) in response.notification.request.content.userInfo {
      if let key = key as? String, key != "aps" { data[key] = value }
    }
    lock.withLock { opened = data }
    emit("onNotificationOpened", data)
    completionHandler()
  }
}
