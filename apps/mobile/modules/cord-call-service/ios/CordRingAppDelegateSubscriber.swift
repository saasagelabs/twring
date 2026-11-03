import ExpoModulesCore
import UIKit

/// Starts PushKit and CallKit at launch, before JS: a VoIP push that wakes the app must be reported
/// to CallKit straight away (CordRing.swift). Also receives the alert token and background pushes.
public class CordRingAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CordRing.shared.start()
    return true
  }

  public func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    CordRing.shared.alertTokenArrived(deviceToken)
  }

  public func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {}

  public func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    CordRing.shared.backgroundPush(userInfo)
    completionHandler(.noData)
  }
}
