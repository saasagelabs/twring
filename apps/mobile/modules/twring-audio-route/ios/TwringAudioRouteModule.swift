import AVFoundation
import ExpoModulesCore

/**
 * Call audio route changes and interruptions (src/platform/audio-route.ts). iOS lists and selects
 * outputs through LiveKit and the system picker; this module only reports when the route changed
 * (AVAudioSession.routeChangeNotification) and when a phone call or another app took the audio
 * (AVAudioSession.interruptionNotification), so the app reacts with the screen off too.
 */
public class TwringAudioRouteModule: Module {
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("TwringAudioRoute")
    Events("onRoutesChanged", "onInterruption")

    Function("startWatching") { [weak self] in
      DispatchQueue.main.async { self?.start() }
    }
    Function("stopWatching") { [weak self] in
      DispatchQueue.main.async { self?.stop() }
    }

    OnDestroy { [weak self] in
      self?.stop()
    }
  }

  private func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onRoutesChanged", [:])
      })
    observers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: session, queue: .main
      ) { [weak self] note in
        guard
          let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        self?.sendEvent("onInterruption", ["phase": type == .began ? "began" : "ended"])
      })
  }

  private func stop() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
  }
}
