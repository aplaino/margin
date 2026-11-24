import Foundation

// What a macOS notification for a message says. One thread per friend, so Notification Center
// stacks each conversation.
struct NotificationContent: Equatable {
  var id: String
  var thread: String
  var title: String
  var subtitle: String
  var body: String
  // Only the first of a burst plays a sound, as in Messages.
  var sound: Bool
}

// How a new message calls for attention: never more than one of these.
enum MessageAlert: Equatable {
  case quiet
  // Margin's own, glow only (or with the drawer open): the strip pulses.
  case pulse
  // Margin's own: the strip pulses and the tab slides out beside it.
  case peek(Peek)
  case notify(NotificationContent)

  // Starts a burst: anything but silence, or a notification without a sound.
  var loud: Bool {
    switch self {
    case .quiet: false
    case .notify(let content): content.sound
    default: true
    }
  }
}

enum Alerts {
  // In a burst from one friend, Margin's own alerts show once in this long and macOS
  // notifications play one sound; every message still counts as unread.
  static let burst: TimeInterval = 30
  // A friend's nudges shake Margin at most once in this long; the rest show only in the chat.
  static let shakeEvery: TimeInterval = 3 * 60

  // Whether a nudge shakes Margin: Settings → Notifications → Nudges on Shake, alerts not
  // paused, and none from this friend shook it recently.
  static func shakes(_ message: ChatMessage, setting: String, paused: Bool, lastShake: Date?, now: Date) -> Bool {
    guard message.nudge, message.incoming, setting == "shake", !paused else { return false }
    return lastShake.map { now.timeIntervalSince($0) >= shakeEvery } ?? true
  }

  // `mode` is Settings → Notifications' choice ("margin" or "macos"), `content` what alerts
  // show ("preview", "name" or "glow"). macOS notifications that aren't allowed fall back to
  // Margin's own alerts. `lastAlert` is the last loud one from this friend.
  static func decide(
    _ message: ChatMessage, from friend: Friend?, mode: String, content: String, allowed: Bool,
    paused: Bool, reading: Bool, expanded: Bool, lastAlert: Date?, now: Date
  ) -> MessageAlert {
    if paused || reading { return .quiet }
    let inBurst = lastAlert.map { now.timeIntervalSince($0) < burst } ?? false
    let name = friend?.displayName ?? message.peer
    let text = message.nudge ? String(localized: "sent you a nudge") : message.text
    // Every message gets one, so the friend's thread holds the whole conversation.
    if mode == "macos", allowed {
      let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return .notify(
        NotificationContent(
          id: message.id, thread: message.peer, title: name, subtitle: friend.map { doing($0.presence) } ?? "",
          body: content == "preview" && !words.isEmpty ? clip(words, 300) : String(localized: "New message"),
          sound: !inBurst))
    }
    if inBurst { return .quiet }
    if content == "glow" || expanded { return .pulse }
    let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
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

// Who coming online gets a note beside the strip (Settings → Notifications → Friends coming
// online), kept quiet: not someone back within a quarter of an hour (sleep, flaky Wi-Fi), at
// most once an hour each, nobody in the minute after Margin starts, reconnects or the Mac
// wakes (everyone already online would look new), and at most three notes a minute.
struct Arrivals {
  static let flap: TimeInterval = 15 * 60
  static let perFriend: TimeInterval = 60 * 60
  static let perMinute = 3
  static let settle: TimeInterval = 60
  // Arrivals this close together show as one note.
  static let batch: TimeInterval = 3

  var wentOffline: [String: Date] = [:]
  var shown: [String: Date] = [:]
  var notes: [Date] = []
  var quietUntil = Date.distantPast

  mutating func settle(from now: Date) { quietUntil = now.addingTimeInterval(Self.settle) }

  mutating func left(_ handle: String, at now: Date) { wentOffline[handle] = now }

  // Whether this friend coming online is worth a note.
  mutating func arrived(_ handle: String, at now: Date) -> Bool {
    let away = wentOffline.removeValue(forKey: handle)
    if now < quietUntil { return false }
    if let away, now.timeIntervalSince(away) < Self.flap { return false }
    if let last = shown[handle], now.timeIntervalSince(last) < Self.perFriend { return false }
    return true
  }

  // One note for these (gathered over `batch`), if the minute's allowance has room.
  mutating func show(_ handles: [String], at now: Date) -> Bool {
    notes.removeAll { now.timeIntervalSince($0) >= 60 }
    guard !handles.isEmpty, notes.count < Self.perMinute else { return false }
    notes.append(now)
    for handle in handles { shown[handle] = now }
    return true
  }
}
