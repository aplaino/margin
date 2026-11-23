import AppKit
import UserNotifications

// Whether macOS lets Margin show notifications, as System Settings → Notifications has it.
enum NotificationAccess { case unknown, notAsked, allowed, off }

// macOS notifications for new messages, when Settings → Notifications chooses them: posting
// them, what a click, Reply and Mark as Read do, and taking them away once read.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  private let center = UNUserNotificationCenter.current()
  private weak var model: AppModel?

  // Before the app runs, so a click that launches Margin still reaches it.
  func start(_ model: AppModel) {
    self.model = model
    center.delegate = self
    let reply = UNTextInputNotificationAction(
      identifier: "reply", title: String(localized: "Reply"), options: [],
      textInputButtonTitle: String(localized: "Send"), textInputPlaceholder: String(localized: "Message"))
    let read = UNNotificationAction(identifier: "read", title: String(localized: "Mark as Read"), options: [])
    center.setNotificationCategories([
      UNNotificationCategory(identifier: "message", actions: [reply, read], intentIdentifiers: [])
    ])
    // Asking again after macOS has an answer shows nothing; it only reports back.
    if model.prefs.alerts == "macos" { ask() } else { refresh() }
  }

  func ask() {
    center.requestAuthorization(options: [.alert, .sound]) { [weak self] _, _ in
      Task { @MainActor in self?.refresh() }
    }
  }

  // System Settings can change it any time, so this is checked again before each alert.
  func refresh(then done: (() -> Void)? = nil) {
    center.getNotificationSettings { [weak self] settings in
      let access: NotificationAccess =
        switch settings.authorizationStatus {
        case .notDetermined: .notAsked
        case .authorized, .provisional: settings.alertStyle == .none ? .off : .allowed
        default: .off
        }
      Task { @MainActor in
        self?.model?.notificationAccess = access
        done?()
      }
    }
  }

  func openSettings() {
    let id = Bundle.main.bundleIdentifier ?? ""
    if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
      NSWorkspace.shared.open(url)
    }
  }

  func post(_ message: NotificationContent) {
    let content = UNMutableNotificationContent()
    content.title = message.title
    content.subtitle = message.subtitle
    content.body = message.body
    content.threadIdentifier = message.thread
    content.categoryIdentifier = "message"
    content.sound = message.sound ? .default : nil
    content.userInfo = ["handle": message.thread]
    center.add(UNNotificationRequest(identifier: message.id, content: content, trigger: nil))
  }

  // A reply from a notification that margind turned down.
  func replyFailed(to handle: String, name: String, error: String?) {
    let content = UNMutableNotificationContent()
    content.title = String(localized: "Your reply to \(name) wasn’t sent")
    content.body = error ?? ""
    content.threadIdentifier = handle
    content.userInfo = ["handle": handle]
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  func remove(_ ids: [String]) {
    center.removeDeliveredNotifications(withIdentifiers: ids)
  }

  // Everything still showing from one friend.
  func removeThread(_ handle: String) {
    center.getDeliveredNotifications { list in
      let ids = list.filter { $0.request.content.threadIdentifier == handle }.map(\.request.identifier)
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
    }
  }

  // Banners even while Margin is the active app, unless that chat is open in the drawer.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let handle = notification.request.content.threadIdentifier
    Task { @MainActor in
      let reading = model.map { $0.expanded && $0.chatWith == handle } ?? false
      completionHandler(reading ? [] : [.banner, .list, .sound])
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let handle = response.notification.request.content.userInfo["handle"] as? String
    let action = response.actionIdentifier
    let text = (response as? UNTextInputNotificationResponse)?.userText
    Task { @MainActor in
      if let handle, let model {
        switch action {
        case "reply": model.reply(text ?? "", to: handle)
        case "read": model.markRead(handle)
        case UNNotificationDefaultActionIdentifier: model.onOpenChat?(handle)
        default: break
        }
      }
      completionHandler()
    }
  }
}
