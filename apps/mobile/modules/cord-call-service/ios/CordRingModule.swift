import ExpoModulesCore
import UIKit

/// JS bridge for incoming agent calls on iOS (CordRing.swift). The Android side of this module is
/// CordCallService (Kotlin); JS reaches this one through src/platform/ring.ios.ts.
public class CordRingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CordRing")

    Events(
      "onPushToken", "onAlertToken", "onRingAnswered", "onRingDeclined", "onCallEnded",
      "onCallMuted", "onNotificationOpened", "onAudioEvent")

    OnCreate {
      CordRing.shared.setEmitter { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnDestroy {
      CordRing.shared.setEmitter(nil)
    }

    AsyncFunction("getPushToken") { () -> String? in
      CordRing.shared.currentVoipToken
    }

    AsyncFunction("getAlertToken") { () -> String? in
      CordRing.shared.currentAlertToken
    }

    Function("alertsAllowed") { () -> Bool in
      CordRing.shared.refreshAlertStatus()
      return CordRing.shared.currentAlertsAllowed
    }

    AsyncFunction("requestAlerts") { (promise: Promise) in
      CordRing.shared.requestAlerts { granted in
        promise.resolve(granted)
      }
    }

    Function("openSettings") {
      DispatchQueue.main.async {
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url)
        }
      }
    }

    Function("clearRing") { (inviteId: String) in
      CordRing.shared.ringEnded(inviteId: inviteId)
    }

    Function("takePendingDeclines") { () -> [String] in
      CordRing.shared.takeDeclines()
    }

    Function("queueDecline") { (inviteId: String) in
      CordRing.shared.queueDecline(inviteId)
    }

    Function("takeAnsweredRing") { () -> [String: Any]? in
      CordRing.shared.takeAnswered()
    }

    Function("takeOpenedNotification") { () -> [String: Any]? in
      CordRing.shared.takeOpened()
    }

    Function("endCall") {
      CordRing.shared.endActiveCall()
    }

    Function("speakThenEnd") { (uri: String, headers: [String: String]) in
      guard let url = URL(string: uri), url.scheme == "https" else {
        CordRing.shared.endActiveCall()
        return
      }
      CordRing.shared.speakThenEnd(url: url, headers: headers)
    }

    Function("setCallActive") { (active: Bool) in
      CordRing.shared.setCallActive(active)
    }

    Function("setMuted") { (muted: Bool) in
      CordRing.shared.setMuted(muted)
    }

    Function("notify") { (title: String, body: String) in
      CordRing.shared.notify(title: title, body: body)
    }

    Function("clearMissedCalls") {
      CordRing.shared.removeMissedCalls()
    }

    Function("setSealKey") { (serverId: String, keyB64url: String) in
      try CordSealKeys.set(serverId: serverId, keyB64url: keyB64url)
    }

    Function("removeSealKey") { (serverId: String) in
      CordSealKeys.remove(serverId: serverId)
    }

    Function("sealSelfTest") { () -> Bool in
      CordSeal.selfTest()
    }

    Function("clearMessages") { (agentId: String) in
      CordRing.shared.removeDelivered(thread: agentId)
    }
  }
}
