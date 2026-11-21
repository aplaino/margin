import AppKit
import Foundation
import Observation
import UserNotifications

enum Tab { case friends, add, settings }
enum SetupStep { case welcome, signIn, tools, addFriend }

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

  var expanded = false
  var tab: Tab = .friends
  var chatWith: String?
  var setupStep: SetupStep = .welcome

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
    case .roster(let r): friends = r
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
    if !reading { pulse += 1 }
    guard prefs.notifications, !reading else { return }
    // Metadata only: who, never what.
    let content = UNMutableNotificationContent()
    content.title = "Margin"
    content.body = "New message from \(friend(message.peer)?.displayName ?? message.peer)"
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: message.id, content: content, trigger: nil))
  }

  func openChat(_ handle: String) {
    chatWith = handle
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
