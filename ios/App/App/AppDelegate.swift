// AppDelegate — APNs registration + push notification handling for WYA
// Phase v4.0: iOS App Shell + APNs
// (c) Universoul LLC | Santa Barbara, CA | 2026

import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    // WYA backend endpoint
    static let wyaBaseURL = "https://wya.digisigns.link"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Set up push notification delegate
        UNUserNotificationCenter.current().delegate = self

        // Request push notification permission
        requestPushPermission()

        return true
    }

    // MARK: - Push Notifications

    func requestPushPermission() {
        // Register notification categories with action buttons
        let viewAction = UNNotificationAction(identifier: "VIEW", title: "View Order", options: [.foreground])
        let trackAction = UNNotificationAction(identifier: "TRACK", title: "Track Vendor", options: [.foreground])

        let orderUpdate = UNNotificationCategory(identifier: "order_update", actions: [viewAction], intentIdentifiers: [])
        let vendorLive = UNNotificationCategory(identifier: "vendor_live", actions: [trackAction], intentIdentifiers: [])
        let orderReady = UNNotificationCategory(identifier: "order_ready", actions: [viewAction], intentIdentifiers: [])

        UNUserNotificationCenter.current().setNotificationCategories([orderUpdate, vendorLive, orderReady])

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            guard granted else {
                print("[WYA-iOS] Push permission denied")
                return
            }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // APNs token received — send to WYA backend
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[WYA-iOS] APNs token: \(token.prefix(20))...")
        registerTokenWithBackend(token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[WYA-iOS] APNs registration failed: \(error.localizedDescription)")
    }

    // Handle notification tap — deep link into the app
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let actionId = response.actionIdentifier

        // Handle categorized notification actions
        if actionId == "VIEW" {
            if let orderId = userInfo["order_id"] as? String {
                // Deep link to order detail
                if let url = URL(string: "wya://order/\(orderId)") {
                    UIApplication.shared.open(url)
                }
            }
        } else if actionId == "TRACK" {
            if let vendorId = userInfo["vendor_id"] as? String {
                // Deep link to vendor on map
                if let url = URL(string: "wya://vendor/\(vendorId)") {
                    UIApplication.shared.open(url)
                }
            }
        }

        // Default tap — open path from notification
        if let path = userInfo["path"] as? String {
            NotificationCenter.default.post(name: .wyaDeepLink, object: nil, userInfo: ["path": path])
        }

        completionHandler()
    }

    // Show notification even when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
    }

    // Handle background push — update badge, refresh data
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // Capacitor will handle forwarding to web layer
        completionHandler(.newData)
    }

    private func registerTokenWithBackend(_ token: String) {
        guard let url = URL(string: "\(Self.wyaBaseURL)/api/ios/register-apns") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        let body: [String: Any] = [
            "token": token,
            "platform": "ios",
            "device_id": deviceId
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            URLSession.shared.dataTask(with: request) { data, response, error in
                if let httpResp = response as? HTTPURLResponse {
                    print("[WYA-iOS] APNs token registered: HTTP \(httpResp.statusCode)")
                }
                if let error = error {
                    print("[WYA-iOS] APNs registration error: \(error.localizedDescription)")
                }
            }.resume()
        } catch {
            print("[WYA-iOS] APNs registration JSON error: \(error)")
        }
    }

    // MARK: - Deep Link Handling

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Handle wya:// deep links
        if url.scheme == "wya" {
            let host = url.host ?? ""
            let path = url.path

            switch host {
            case "order":
                // wya://order/{orderId}
                let orderId = path.replacingOccurrences(of: "/", with: "")
                NotificationCenter.default.post(name: .wyaDeepLink, object: nil, userInfo: ["path": "/customer?order=\(orderId)"])
            case "vendor":
                // wya://vendor/{vendorId}
                let vendorId = path.replacingOccurrences(of: "/", with: "")
                NotificationCenter.default.post(name: .wyaDeepLink, object: nil, userInfo: ["path": "/customer?vendor=\(vendorId)"])
            case "map":
                // wya://map
                NotificationCenter.default.post(name: .wyaDeepLink, object: nil, userInfo: ["path": "/customer"])
            default:
                break
            }
            return true
        }

        // Let Capacitor handle other URLs
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

extension Notification.Name {
    static let wyaDeepLink = Notification.Name("wyaDeepLink")
}
