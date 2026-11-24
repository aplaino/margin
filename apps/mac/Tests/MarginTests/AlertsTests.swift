import Foundation
import Testing

@testable import Margin

@Suite struct AlertsTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let maya = Friend(
    handle: "maya", name: "Maya Chen",
    presence: Presence(
      status: "online",
      activity: Activity(tool: "claude-code", project: Project(visibility: "public", repo: "maya/tidepool-ui")), at: 0),
    lastSeenAt: 0, unread: 1)

  func message(_ text: String) -> ChatMessage {
    ChatMessage(id: "m1", peer: "maya", direction: "in", text: text, sentAt: 0)
  }

  func decide(
    _ text: String = "want to pair?\nafter lunch", friend: Friend? = nil, mode: String = "margin",
    content: String = "preview", allowed: Bool = true, paused: Bool = false, reading: Bool = false,
    expanded: Bool = false, lastAlert: Date? = nil
  ) -> MessageAlert {
    Alerts.decide(
      message(text), from: friend ?? maya, mode: mode, content: content, allowed: allowed, paused: paused,
      reading: reading, expanded: expanded, lastAlert: lastAlert, now: now)
  }

  @Test func marginPreviewShowsTheFirstLine() {
    #expect(decide() == .peek(Peek(id: "m1", handle: "maya", name: "Maya Chen", preview: "want to pair?")))
    let long = String(repeating: "a", count: 70)
    #expect(decide(long) == .peek(Peek(id: "m1", handle: "maya", name: "Maya Chen", preview: String(repeating: "a", count: 60) + "…")))
  }

  @Test func marginNameAndGlow() {
    #expect(decide(content: "name") == .peek(Peek(id: "m1", handle: "maya", name: "Maya Chen", preview: nil)))
    #expect(decide(content: "glow") == .pulse)
    // The drawer is open on another page: the strip pulses, no tab.
    #expect(decide(expanded: true) == .pulse)
  }

  @Test func macosPreview() {
    let alert = decide(mode: "macos")
    #expect(
      alert
        == .notify(
          NotificationContent(
            id: "m1", thread: "maya", title: "Maya Chen", subtitle: "Claude Code · maya/tidepool-ui",
            body: "want to pair?\nafter lunch", sound: true)))
    let long = String(repeating: "b", count: 320)
    guard case .notify(let content) = decide(long, mode: "macos") else { Issue.record("no notification"); return }
    #expect(content.body == String(repeating: "b", count: 300) + "…")
  }

  @Test func macosNameOnly() {
    guard case .notify(let content) = decide(mode: "macos", content: "name") else {
      Issue.record("no notification")
      return
    }
    #expect(content.title == "Maya Chen")
    #expect(content.body == "New message")
    // An empty preview says the same.
    guard case .notify(let empty) = decide("  \n ", mode: "macos") else { Issue.record("no notification"); return }
    #expect(empty.body == "New message")
  }

  @Test func macosEvenWithTheDrawerOpenOnAnotherChat() {
    guard case .notify = decide(mode: "macos", expanded: true) else {
      Issue.record("no notification")
      return
    }
  }

  @Test func macosNotAllowedFallsBackToMargin() {
    #expect(decide(mode: "macos", allowed: false) == .peek(Peek(id: "m1", handle: "maya", name: "Maya Chen", preview: "want to pair?")))
    #expect(decide(mode: "macos", content: "name", allowed: false) == .peek(Peek(id: "m1", handle: "maya", name: "Maya Chen", preview: nil)))
  }

  @Test func quietWhenPausedOrReading() {
    for mode in ["margin", "macos"] {
      #expect(decide(mode: mode, paused: true) == .quiet)
      #expect(decide(mode: mode, reading: true, expanded: true) == .quiet)
    }
  }

  // Margin's own alerts show once per burst; macOS gets every message, with one sound.
  @Test func bursts() {
    let recent = now.addingTimeInterval(-29)
    let earlier = now.addingTimeInterval(-31)
    #expect(decide(lastAlert: recent) == .quiet)
    #expect(decide(lastAlert: earlier).loud)
    guard case .notify(let inBurst) = decide(mode: "macos", lastAlert: recent),
      case .notify(let after) = decide(mode: "macos", lastAlert: earlier)
    else {
      Issue.record("no notification")
      return
    }
    #expect(!inBurst.sound && inBurst.body == "want to pair?\nafter lunch")
    #expect(after.sound)
    // A silent one doesn't start a new burst, so a steady chat still sounds every 30 s.
    #expect(!MessageAlert.notify(inBurst).loud)
    #expect(MessageAlert.notify(after).loud)
    #expect(!MessageAlert.quiet.loud)
  }

  @Test func unknownSenderUsesTheHandle() {
    let alert = Alerts.decide(
      message("hi"), from: nil, mode: "macos", content: "preview", allowed: true, paused: false, reading: false,
      expanded: false, lastAlert: nil, now: now)
    #expect(alert == .notify(NotificationContent(id: "m1", thread: "maya", title: "maya", subtitle: "", body: "hi", sound: true)))
  }

  @Test func subtitleIsOnlyWhatTheyShare() {
    #expect(Alerts.doing(maya.presence) == "Claude Code · maya/tidepool-ui")
    #expect(Alerts.doing(Presence(status: "online", at: 0)) == "")
    #expect(Alerts.doing(Presence(status: "idle", at: 0)) == "")
    // Only a model shared: nothing worth a subtitle.
    #expect(Alerts.doing(Presence(status: "online", activity: Activity(model: "opus"), at: 0)) == "")
    #expect(Alerts.doing(Presence(status: "offline", activity: Activity(tool: "codex"), at: 0)) == "")
    let hidden = Presence(status: "idle", activity: Activity(tool: "opencode", project: Project(visibility: "private")), at: 0)
    #expect(Alerts.doing(hidden) == "idle · OpenCode · private project")
  }

  @Test func migration() throws {
    func migrated(_ before: [String: Any]) throws -> (alerts: String?, alert: String?, old: Bool) {
      let name = "margin.tests.\(UUID().uuidString)"
      let defaults = try #require(UserDefaults(suiteName: name))
      defer { defaults.removePersistentDomain(forName: name) }
      for (key, value) in before { defaults.set(value, forKey: key) }
      Prefs.migrate(defaults)
      return (defaults.string(forKey: "alerts"), defaults.string(forKey: "alert"), defaults.object(forKey: "notifications") != nil)
    }
    // Never had it: nothing changes.
    let fresh = try migrated(["alert": "glow"])
    #expect(fresh.alerts == nil && fresh.alert == "glow" && !fresh.old)
    // Off: Margin's own alerts, as before.
    let off = try migrated(["notifications": false, "alert": "preview"])
    #expect(off.alerts == nil && off.alert == "preview" && !off.old)
    // On: macOS notifications with the name only, whatever Margin's own showed.
    for alert in ["preview", "name", "glow"] {
      let on = try migrated(["notifications": true, "alert": alert])
      #expect(on.alerts == "macos" && on.alert == "name" && !on.old)
    }
  }
}

@Suite struct ArrivalsTests {
  let start = Date(timeIntervalSince1970: 1_800_000_000)
  func at(_ minutes: Double) -> Date { start.addingTimeInterval(minutes * 60) }

  @Test func quietRightAfterStartingOrReconnecting() {
    var arrivals = Arrivals()
    arrivals.settle(from: at(0))
    let r1 = arrivals.arrived("maya", at: at(0.5))
    #expect(!r1)
    let r2 = arrivals.arrived("maya", at: at(1.5))
    #expect(r2)
  }

  // Back within a quarter of an hour is the same session; later counts again.
  @Test func flappingIsIgnored() {
    var arrivals = Arrivals()
    arrivals.left("maya", at: at(0))
    let r3 = arrivals.arrived("maya", at: at(10))
    #expect(!r3)
    arrivals.left("maya", at: at(20))
    let r4 = arrivals.arrived("maya", at: at(40))
    #expect(r4)
  }

  @Test func oncePerFriendPerHour() {
    var arrivals = Arrivals()
    let r5 = arrivals.arrived("maya", at: at(0))
    #expect(r5)
    let r6 = arrivals.show(["maya"], at: at(0))
    #expect(r6)
    arrivals.left("maya", at: at(1))
    let r7 = arrivals.arrived("maya", at: at(30))
    #expect(!r7)
    arrivals.left("maya", at: at(31))
    let r8 = arrivals.arrived("maya", at: at(61))
    #expect(r8)
  }

  @Test func atMostThreeNotesAMinute() {
    var arrivals = Arrivals()
    let r9 = arrivals.show(["a"], at: at(0))
    #expect(r9)
    let r10 = arrivals.show(["b"], at: at(0.2))
    #expect(r10)
    let r11 = arrivals.show(["c"], at: at(0.4))
    #expect(r11)
    let r12 = arrivals.show(["d"], at: at(0.6))
    #expect(!r12)
    let r13 = arrivals.show(["d"], at: at(1.1))
    #expect(r13)
    let r14 = arrivals.show([], at: at(5))
    #expect(!r14)
  }
}

@Suite struct NudgeTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let nudge = ChatMessage(id: "n1", peer: "maya", direction: "in", text: "", sentAt: 0, kind: "nudge")

  // Once every three minutes per friend, only on Shake, never while paused, never your own.
  @Test func shakesSparingly() {
    #expect(Alerts.shakes(nudge, setting: "shake", paused: false, lastShake: nil, now: now))
    #expect(!Alerts.shakes(nudge, setting: "shake", paused: false, lastShake: now.addingTimeInterval(-120), now: now))
    #expect(Alerts.shakes(nudge, setting: "shake", paused: false, lastShake: now.addingTimeInterval(-180), now: now))
    #expect(!Alerts.shakes(nudge, setting: "quiet", paused: false, lastShake: nil, now: now))
    #expect(!Alerts.shakes(nudge, setting: "shake", paused: true, lastShake: nil, now: now))
    var mine = nudge
    mine.direction = "out"
    #expect(!Alerts.shakes(mine, setting: "shake", paused: false, lastShake: nil, now: now))
    let text = ChatMessage(id: "m1", peer: "maya", direction: "in", text: "hi", sentAt: 0)
    #expect(!Alerts.shakes(text, setting: "shake", paused: false, lastShake: nil, now: now))
  }

  @Test func peekSaysWhatItIs() {
    let alert = Alerts.decide(
      nudge, from: nil, mode: "margin", content: "preview", allowed: true, paused: false, reading: false,
      expanded: false, lastAlert: nil, now: now)
    #expect(alert == .peek(Peek(id: "n1", handle: "maya", name: "maya", preview: "sent you a nudge")))
  }
}
