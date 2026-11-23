import AppKit
import Foundation
import Observation

enum Tab { case friends, chats, add, settings }
enum SetupStep { case welcome, guide, signIn, tools, addFriend }

@Observable @MainActor
final class AppModel {
  let prefs = Prefs()
  let client = DaemonClient(path: DaemonClient.defaultPath())
  let updates = Updates()
  @ObservationIgnored let notifier = Notifier()
  var notificationAccess = NotificationAccess.unknown
  // Called when the connection to margind drops, so a new one can be started.
  var onDaemonLost: (() -> Void)?
  // Opens the drawer on a chat, as clicking the tab beside the strip does.
  @ObservationIgnored var onOpenChat: ((String) -> Void)?
  // Replies from notifications wait here while margind isn't connected yet.
  @ObservationIgnored private var pendingReplies: [(handle: String, text: String)] = []
  // The friend the last reply from a notification went to, until margind answers.
  @ObservationIgnored private var replyingTo: String?

  var daemonUp = false
  var me: SelfInfo?
  var settings: PrivacySettings?
  var tools: [ToolState] = []
  var friends: [Friend] = []
  var requests = Requests(incoming: [], outgoing: [])
  var conversations: [String: [ChatMessage]] = [:]
  // The newest message with each friend, for the Chats tab.
  var latest: [String: ChatMessage] = [:]
  var loginCode: (code: String, uri: String)?
  var loginError: String?
  var signingIn = false
  // Last result per operation, for showing errors and notes where they happened.
  var results: [String: (ok: Bool, message: String?)] = [:]
  // Bumped on each new incoming message; the strip pulses once.
  var pulse = 0
  // The message tab beside the strip, while it's out.
  var peek: Peek?
  @ObservationIgnored private var lastAlert: [String: Date] = [:]
  var moveError: String?
  // The how-it-works pages, opened again from Settings.
  var showGuide = false
  // Crash and error reports waiting on this Mac.
  var reports = (count: 0, crash: false)
  // Find friends, the people you've blocked, and safety numbers shown so far.
  var directory: [Person] = []
  var blocked: [String] = []
  var safety: [String: String] = [:]
  var showThemeEditor = false
  // The Settings page open, or the list of them.
  var settingsPage: SettingsPage? { didSet { cursor = nil } }
  private var askingAboutReports = false

  var expanded = false
  var stripHovered = false
  // Where the drawer is showing right now: under the menu bar item, or at a screen edge
  // (including when macOS has hidden the menu bar item).
  var atTop = false
  var menuBarHidden = false
  var tab: Tab = .friends
  var chatWith: String?
  // The profile open (a friend's, or yours); a chat opened from it comes back to it.
  var profileOf: String?
  // GitHub profile pictures, fetched once each (URLCache keeps them across launches).
  var avatars: [String: NSImage] = [:]
  @ObservationIgnored private var avatarLoads: Set<String> = []
  // The friend picked with ↑/↓, highlighted in the list.
  var selected: String?
  // True while you're moving around with the keyboard: outlines show only then, like focus
  // rings. Clicking, scrolling or moving the pointer over the drawer turns it off.
  var keyboardNav = false
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

  // Friends you've talked to, most recent conversation first.
  var chats: [Friend] {
    friends.filter { latest[$0.handle] != nil }.sorted { latest[$0.handle]!.sentAt > latest[$1.handle]!.sentAt }
  }

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
      guard let self else { return }
      daemonUp = up
      if up {
        let waiting = pendingReplies
        pendingReplies = []
        for reply in waiting { self.reply(reply.text, to: reply.handle) }
      } else {
        me = nil
        onDaemonLost?()
      }
    }
    client.onPush = { [weak self] push in self?.handle(push) }
    client.start()
    notifier.start(self)
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
        if message.unsent { notifier.remove([message.id]) }
      } else {
        list.append(message)
        if message.incoming { received(message) }
      }
      conversations[message.peer] = list.sorted { $0.sentAt < $1.sentAt }
      // Newer than what the Chats tab shows, or a state change to the same message.
      let shown = latest[message.peer]
      if shown == nil || shown?.id == message.id || message.sentAt >= shown?.sentAt ?? 0 {
        latest[message.peer] = message
      }
      if message.incoming, expanded, chatWith == message.peer { request("read", ["handle": message.peer]) }
    case .history(let with, let messages):
      conversations[with] = messages
      if let last = messages.last, last.sentAt >= latest[with]?.sentAt ?? 0 { latest[with] = last }
    case .chats(let list):
      latest = Dictionary(list.map { ($0.peer, $0) }, uniquingKeysWith: { first, _ in first })
    case .result(let op, let ok, let data, let error):
      results[op] = (ok, ok ? data?.note : error)
      if op == "send", let to = replyingTo {
        replyingTo = nil
        if !ok { notifier.replyFailed(to: to, name: friend(to)?.displayName ?? to, error: error) }
      }
      if ok, let people = data?.people { directory = people }
      if ok, let list = data?.blocked { blocked = list }
      if ok, let handle = data?.handle, let number = data?.safety { safety[handle] = number }
      // A friend you removed or blocked has no chat to stay in.
      if ok, op == "friend.remove" || op == "block" {
        chatWith = nil
        profileOf = nil
      }
    case .reports(let count, let crash):
      reports = (count, crash)
      handleReports()
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
    // Whether macOS still allows notifications decides which kind this is.
    if prefs.alerts == "macos" { notifier.refresh { [weak self] in self?.alert(message) } } else { alert(message) }
  }

  // Paused, a burst from the same friend, or the chat open: it still counts as unread, it just
  // doesn't call for attention.
  private func alert(_ message: ChatMessage) {
    let now = Date.now
    let alert = Alerts.decide(
      message, from: friend(message.peer), mode: prefs.alerts, content: prefs.alert,
      allowed: notificationAccess == .allowed, paused: prefs.alertsPaused,
      reading: expanded && chatWith == message.peer, expanded: expanded, lastAlert: lastAlert[message.peer], now: now)
    if alert != .quiet { lastAlert[message.peer] = now }
    switch alert {
    case .quiet: break
    case .pulse: pulse += 1
    case .peek(let next):
      pulse += 1
      peek = next
    case .notify(let content): notifier.post(content)
    }
  }

  // The chat field's send: the link preview is fetched here, on the sender's Mac, and follows
  // the message.
  func send(_ text: String, to handle: String) {
    request("send", ["to": handle, "text": text])
    guard settings?.linkPreviews ?? true, let url = LinkPreviews.firstLink(in: text) else { return }
    Task {
      guard let preview = await LinkPreviews.fetch(url),
        let data = try? JSONEncoder().encode(preview),
        let object = try? JSONSerialization.jsonObject(with: data)
      else { return }
      request("preview", ["to": handle, "preview": object])
    }
  }

  // Reply on a notification: sent like the chat field, and the chat is read, as in Messages.
  // Waits for margind if clicking Reply is what opened Margin.
  func reply(_ text: String, to handle: String) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    guard daemonUp else {
      pendingReplies.append((handle, text))
      return
    }
    replyingTo = handle
    send(text, to: handle)
    markRead(handle)
  }

  func markRead(_ handle: String) {
    request("read", ["handle": handle])
    notifier.removeThread(handle)
  }

  // ↑/↓ through the list on screen: friends, or chats.
  func moveSelection(_ delta: Int) {
    let handles = (tab == .chats ? chats : onlineFriends + offlineFriends).map(\.handle)
    guard !handles.isEmpty else { return }
    // The first press after using the mouse shows where you are rather than moving on.
    if !keyboardNav, let selected, handles.contains(selected) {
      keyboardNav = true
      return
    }
    keyboardNav = true
    let current = selected.flatMap { handles.firstIndex(of: $0) } ?? (delta > 0 ? -1 : handles.count)
    selected = handles[min(max(current + delta, 0), handles.count - 1)]
  }

  func moveCursor(_ delta: Int) {
    let ids = controls.map(\.id)
    guard !ids.isEmpty else { return }
    keyboardNav = true
    let current = cursor.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
    cursor = ids[min(max(current + delta, 0), ids.count - 1)]
  }

  var control: Control? { controls.first { $0.id == cursor } }

  var cursorMessage: ChatMessage? {
    guard let chatWith, let cursor else { return nil }
    return conversations[chatWith]?.first { $0.id == cursor }
  }

  func copy(_ message: ChatMessage) {
    guard !message.unsent else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(message.text, forType: .string)
  }

  // Like Messages: Delete removes it from this Mac only, after asking.
  func delete(_ message: ChatMessage) {
    let name = friend(message.peer)?.displayName ?? message.peer
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = String(localized: "Delete this message?")
    alert.informativeText = String(localized: "It’s removed from this Mac. \(name) keeps their copy.")
    alert.addButton(withTitle: String(localized: "Delete"))
    alert.addButton(withTitle: String(localized: "Cancel"))
    alert.buttons.first?.hasDestructiveAction = true
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    if cursor == message.id { cursor = nil }
    request("delete", ["id": message.id])
    notifier.remove([message.id])
  }

  func undoSend(_ message: ChatMessage) {
    request("unsend", ["id": message.id])
  }

  func tryAgain(_ message: ChatMessage) {
    request("retry", ["id": message.id])
  }

  func deleteConversation(_ handle: String) {
    let name = friend(handle)?.displayName ?? handle
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = String(localized: "Delete the conversation with \(name)?")
    alert.informativeText = String(localized: "All messages with \(name) are removed from this Mac. They keep their copy.")
    alert.addButton(withTitle: String(localized: "Delete"))
    alert.addButton(withTitle: String(localized: "Cancel"))
    alert.buttons.first?.hasDestructiveAction = true
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    cursor = nil
    request("chat.delete", ["handle": handle])
    notifier.removeThread(handle)
  }

  func showTab(_ next: Tab) {
    chatWith = nil
    profileOf = nil
    showThemeEditor = false
    settingsPage = nil
    cursor = nil
    tab = next
  }

  func cycleTab(_ delta: Int) {
    let tabs: [Tab] = [.friends, .chats, .add, .settings]
    let index = tabs.firstIndex(of: tab) ?? 0
    showTab(tabs[(index + delta + tabs.count) % tabs.count])
  }

  // The pointer moved, clicked or scrolled over the drawer: outlines go, and nothing stays
  // outlined for Return or Space to press unseen.
  func pointerUsed() {
    guard keyboardNav else { return }
    keyboardNav = false
    cursor = nil
  }

  func openProfile(_ handle: String) {
    if peek?.handle == handle { peek = nil }
    if handle != me?.handle { selected = handle }
    chatWith = nil
    profileOf = handle
    cursor = nil
  }

  // Handles are GitHub logins (checked by the protocol), so the address is always GitHub's.
  func loadAvatar(_ handle: String) {
    guard avatars[handle] == nil, avatarLoads.insert(handle).inserted,
      let url = URL(string: "https://github.com/\(handle).png?size=128")
    else { return }
    Task {
      let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 20)
      guard let (data, response) = try? await URLSession.shared.data(for: request),
        (response as? HTTPURLResponse)?.statusCode == 200, let image = NSImage(data: data)
      else {
        avatarLoads.remove(handle)
        return
      }
      avatars[handle] = image
    }
  }

  func openChat(_ handle: String) {
    if peek?.handle == handle { peek = nil }
    if profileOf != handle { profileOf = nil }
    selected = handle
    chatWith = handle
    cursor = nil
    request("history", ["with": handle])
    markRead(handle)
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

  // Always send, never send, or ask after a crash (errors that aren't crashes wait and go
  // with the next report you send, or from Settings).
  private func handleReports() {
    guard reports.count > 0 else { return }
    switch prefs.crashReports {
    case "always": request("reports.send")
    case "never": request("reports.discard")
    default: if reports.crash, !askingAboutReports { askAboutReports() }
    }
  }

  private func askAboutReports() {
    askingAboutReports = true
    defer { askingAboutReports = false }
    let previous = NSWorkspace.shared.frontmostApplication
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = String(localized: "Margin quit unexpectedly")
    alert.informativeText = String(
      localized: "Send a report so it can be fixed? It has the app and macOS versions, what went wrong and recent background log lines. Paths, names, repos and messages are removed first; it never includes your code, prompts or chats.")
    alert.addButton(withTitle: String(localized: "Send Report"))
    alert.addButton(withTitle: String(localized: "Don’t Send"))
    alert.showsSuppressionButton = true
    alert.suppressionButton?.title = String(localized: "Always send reports")
    let send = alert.runModal() == .alertFirstButtonReturn
    if send, alert.suppressionButton?.state == .on { prefs.crashReports = "always" }
    request(send ? "reports.send" : "reports.discard")
    previous?.activate()
  }

  // Margin's own alerts or macOS notifications; macOS has no glow, so that becomes the name.
  func setAlerts(_ mode: String) {
    prefs.alerts = mode
    guard mode == "macos" else { return }
    if prefs.alert == "glow" { prefs.alert = "name" }
    notifier.ask()
  }
}
