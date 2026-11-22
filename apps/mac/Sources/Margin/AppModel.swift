import AppKit
import Foundation
import Observation
import UserNotifications

enum Tab { case friends, add, settings }
enum SetupStep { case welcome, guide, signIn, tools, addFriend }

@Observable @MainActor
final class AppModel {
  let prefs = Prefs()
  let client = DaemonClient(path: DaemonClient.defaultPath())
  let updates = Updates()

  var daemonUp = false
  var me: SelfInfo?
  var settings: PrivacySettings?
  var tools: [ToolState] = []
  var friends: [Friend] = []
  var requests = Requests(incoming: [], outgoing: [])
  var conversations: [String: [ChatMessage]] = [:]
  var loginCode: (code: String, uri: String)?
  var loginError: String?
  var signingIn = false
  // Last result per operation, for showing errors and notes where they happened.
  var results: [String: (ok: Bool, message: String?)] = [:]
  // Bumped on each new incoming message; the strip pulses once.
  var pulse = 0
  // The message tab beside the strip, while it's out.
  var peek: Peek?
  var moveError: String?
  // The how-it-works pages, opened again from Settings.
  var showGuide = false

  var expanded = false
  var stripHovered = false
  // Where the drawer is showing right now: under the menu bar item, or at a screen edge
  // (including when macOS has hidden the menu bar item).
  var atTop = false
  var menuBarHidden = false
  var tab: Tab = .friends
  var chatWith: String?
  // The friend picked with ↑/↓, highlighted in the list.
  var selected: String?
  // The control (Add, Settings) or message (chat) outlined with ↑/↓.
  var cursor: String?
  // What ↑/↓ can reach on the Add or Settings tab, as the views last reported it.
  @ObservationIgnored var controls: [Control] = []
  // True while the drawer has the keyboard (opened with ⌥M, or clicked into); only then may a
  // field take focus by itself, so keystrokes meant for your work never land in Margin.
  var drawerFocused = false
  var setupStep: SetupStep = .welcome

  // A release build running from Downloads runs from a temporary read-only copy
  // (App Translocation): it can't update itself, and tool hooks would point at a path
  // that disappears.
  var misplaced: Bool {
    let path = Bundle.main.bundlePath
    return updates.enabled && (path.contains("/AppTranslocation/") || !path.hasPrefix("/Applications/"))
  }

  var signedIn: Bool { daemonUp && me != nil && me?.connection != "signed-out" }
  var needsSetup: Bool { daemonUp && (!signedIn || !prefs.setupDone) }
  var unreadTotal: Int { friends.reduce(0) { $0 + $1.unread } }

  // In a tool first, then online, then idle; offline listed apart.
  var onlineFriends: [Friend] {
    func rank(_ f: Friend) -> Int {
      if f.presence.status == "idle" { return 2 }
      return f.presence.activity == nil ? 1 : 0
    }
    return friends.filter(\.isOnline).sorted {
      (rank($0), $0.displayName.lowercased()) < (rank($1), $1.displayName.lowercased())
    }
  }
  var offlineFriends: [Friend] {
    friends.filter { !$0.isOnline }.sorted { $0.lastSeenAt > $1.lastSeenAt }
  }

  init() {
    updates.model = self
    client.onConnected = { [weak self] up in
      self?.daemonUp = up
      if !up { self?.me = nil }
    }
    client.onPush = { [weak self] push in self?.handle(push) }
    client.start()
  }

  func request(_ op: String, _ fields: [String: Any] = [:]) {
    results[op] = nil
    var body = fields
    body["op"] = op
    client.send(body)
  }

  func friend(_ handle: String) -> Friend? { friends.first { $0.handle == handle } }

  private func handle(_ push: Push) {
    switch push {
    case .selfInfo(let info):
      // Too old for the server: look for an update straight away.
      if info.connection == "update-required", me?.connection != "update-required" { updates.checkInBackground() }
      me = info
      if info.connection == "signed-out" { setupStep = prefs.setupDone ? .signIn : setupStep }
    case .loginCode(let code, let uri):
      loginCode = (code, uri)
      // Only ever open GitHub's own page.
      if let url = URL(string: uri), url.scheme == "https", url.host == "github.com" {
        NSWorkspace.shared.open(url)
      }
    case .loginDone:
      signingIn = false
      loginCode = nil
      loginError = nil
      if !prefs.setupDone { setupStep = .tools }
    case .loginFailed(let error):
      signingIn = false
      loginCode = nil
      loginError = error
    case .settings(let s): settings = s
    case .tools(let t): tools = t
    case .roster(let r):
      friends = r
      if let selected, !r.contains(where: { $0.handle == selected }) { self.selected = nil }
    case .requests(let r): requests = r
    case .message(let message):
      var list = conversations[message.peer] ?? []
      if let index = list.firstIndex(where: { $0.id == message.id }) {
        list[index] = message
      } else {
        list.append(message)
        if message.incoming { received(message) }
      }
      conversations[message.peer] = list.sorted { $0.sentAt < $1.sentAt }
      if message.incoming, expanded, chatWith == message.peer { request("read", ["handle": message.peer]) }
    case .history(let with, let messages):
      conversations[with] = messages
    case .result(let op, let ok, let data, let error):
      results[op] = (ok, ok ? data?.note : error)
    case .export(let data):
      results["account.export"] = (true, nil)
      NSApp.activate()
      let panel = NSSavePanel()
      panel.nameFieldStringValue = "margin-export.json"
      panel.allowedContentTypes = [.json]
      if panel.runModal() == .OK, let url = panel.url { try? data.write(to: url) }
    }
  }

  private func received(_ message: ChatMessage) {
    let reading = expanded && chatWith == message.peer
    if !reading {
      pulse += 1
      if prefs.alert != "glow", !expanded {
        let line = message.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let words = line.trimmingCharacters(in: .whitespaces)
        peek = Peek(
          id: message.id, handle: message.peer, name: friend(message.peer)?.displayName ?? message.peer,
          preview: prefs.alert == "preview" && !words.isEmpty ? (words.count > 60 ? words.prefix(60) + "…" : words) : nil)
      }
    }
    guard prefs.notifications, !reading else { return }
    // Metadata only: who, never what.
    let content = UNMutableNotificationContent()
    content.title = "Margin"
    content.body = "New message from \(friend(message.peer)?.displayName ?? message.peer)"
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: message.id, content: content, trigger: nil))
  }

  func moveSelection(_ delta: Int) {
    let handles = (onlineFriends + offlineFriends).map(\.handle)
    guard !handles.isEmpty else { return }
    let current = selected.flatMap { handles.firstIndex(of: $0) } ?? (delta > 0 ? -1 : handles.count)
    selected = handles[min(max(current + delta, 0), handles.count - 1)]
  }

  func moveCursor(_ delta: Int) {
    let ids = controls.map(\.id)
    guard !ids.isEmpty else { return }
    let current = cursor.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
    cursor = ids[min(max(current + delta, 0), ids.count - 1)]
  }

  var control: Control? { controls.first { $0.id == cursor } }

  var cursorMessage: ChatMessage? {
    guard let chatWith, let cursor else { return nil }
    return conversations[chatWith]?.first { $0.id == cursor }
  }

  func copy(_ message: ChatMessage) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(message.text, forType: .string)
  }

  func showTab(_ next: Tab) {
    chatWith = nil
    cursor = nil
    tab = next
  }

  func cycleTab(_ delta: Int) {
    let tabs: [Tab] = [.friends, .add, .settings]
    let index = tabs.firstIndex(of: tab) ?? 0
    showTab(tabs[(index + delta + tabs.count) % tabs.count])
  }

  func openChat(_ handle: String) {
    if peek?.handle == handle { peek = nil }
    selected = handle
    chatWith = handle
    cursor = nil
    request("history", ["with": handle])
    request("read", ["handle": handle])
  }

  func updateSettings(_ change: (inout PrivacySettings) -> Void) {
    guard var next = settings else { return }
    change(&next)
    settings = next
    guard let data = try? JSONEncoder().encode(next),
      let object = try? JSONSerialization.jsonObject(with: data)
    else { return }
    request("settings.set", ["settings": object])
  }

  func setNotifications(_ on: Bool) {
    prefs.notifications = on
    if on {
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }
    }
  }
}
