import Foundation

// What a macOS notification for a message says. One thread per friend, so Notification Center
// stacks each conversation.
struct NotificationContent: Equatable {
  var id: String
  var thread: String
  var title: String
  var subtitle: String
  var body: String
}

// How a new message calls for attention: never more than one of these.
enum MessageAlert: Equatable {
  case quiet
  // Margin's own, glow only (or with the drawer open): the strip pulses.
  case pulse
  // Margin's own: the strip pulses and the tab slides out beside it.
  case peek(Peek)
  case notify(NotificationContent)
}

enum Alerts {
  // Bursts from one friend alert once in this long; the rest still count as unread.
  static let burst: TimeInterval = 30

  // `mode` is Settings → Notifications' choice ("margin" or "macos"), `content` what alerts
  // show ("preview", "name" or "glow"). macOS notifications that aren't allowed fall back to
  // Margin's own alerts.
  static func decide(
    _ message: ChatMessage, from friend: Friend?, mode: String, content: String, allowed: Bool,
    paused: Bool, reading: Bool, expanded: Bool, lastAlert: Date?, now: Date
  ) -> MessageAlert {
    if paused || reading { return .quiet }
    if let lastAlert, now.timeIntervalSince(lastAlert) < burst { return .quiet }
    let name = friend?.displayName ?? message.peer
    if mode == "macos", allowed {
      let words = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      return .notify(
        NotificationContent(
          id: message.id, thread: message.peer, title: name, subtitle: friend.map { doing($0.presence) } ?? "",
          body: content == "preview" && !words.isEmpty ? clip(words, 300) : String(localized: "New message")))
    }
    if content == "glow" || expanded { return .pulse }
    let line = message.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    let words = line.trimmingCharacters(in: .whitespaces)
    return .peek(
      Peek(id: message.id, handle: message.peer, name: name, preview: content == "preview" && !words.isEmpty ? clip(words, 60) : nil))
  }

  // What they're doing, as they share it with you; nothing when it would only say online or idle.
  static func doing(_ presence: Presence) -> String {
    guard presence.status != "offline", let activity = presence.activity, activity.tool != nil || activity.project != nil
    else { return "" }
    return Format.what(presence)
  }

  private static func clip(_ text: String, _ length: Int) -> String {
    text.count > length ? text.prefix(length) + "…" : text
  }
}
