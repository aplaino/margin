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
  // Bumped when a friend's nudge should shake Margin.
  var shake = 0
  @ObservationIgnored private var lastShake: [String: Date] = [:]
  // The message tab beside the strip, while it's out.
  var peek: Peek?
  @ObservationIgnored private var lastAlert: [String: Date] = [:]
  // Friends coming online: the rules, and who's gathered for the next note.
  @ObservationIgnored private var arrivals = Arrivals()
  @ObservationIgnored private var arriving: [String] = []
  var moveError: String?
  // The how-it-works pages, opened again from Settings.
  var showGuide = false
  // Crash and error reports waiting on this Mac, and when the oldest was kept.
  var reports: (count: Int, crash: Bool, since: Date?) = (0, false, nil)
  // Errors (not crashes) waited long enough to ask about in the drawer, and what they'd send
  // once you ask to see it.
  var askAboutErrors = false
  var waitingReports: [WaitingReport]?
  // Find friends, the people you've blocked, and safety numbers shown so far.
  var directory: [Person] = []
  var blocked: [String] = []
  var safety: [String: String] = [:]
  var showThemeEditor = false
  // The Settings page open, or the list of them.
  var settingsPage: SettingsPage? { didSet { cursor = nil } }
  private var askingAboutReports = false

  var expanded = false {
    didSet {
      if expanded {
        checkWaitingErrors()
        readOpenChat()
      }
    }
  }
  var stripHovered = false
  // Where the drawer is showing right now: under the menu bar item, or at a screen edge
  // (including when macOS has hidden the menu bar item).
  var atTop = false
  var menuBarHidden = false
  var tab: Tab = .friends
  var chatWith: String?
  // Search on the Chats tab: what's typed (kept while a chat opened from it is open, as in
  // Messages), the messages found and the search they answer.
  var chatSearch = ""
  var searchResults: [ChatMessage] = []
  var searchedFor: String?
  // Asks the Chats tab to put the keyboard in its search field (⌘F).
  var wantsSearchFocus = false
  // New chat on the Chats tab: a friend picker, and what it's filtered by.
  var newChat = false
  var newChatFilter = ""
  // A message to scroll to and outline briefly once its chat has it (a search result).
  var jumpTo: String?
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
  // Times are shown in the Mac's time zone, which macOS changes as you travel (Date & Time →
  // Set time zone automatically). A running app keeps the old one until it's told to look again.
  var timeZone = TimeZone.current

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

  // What's sent to margind, which takes up to 100 characters.
  var searchQuery: String { String(chatSearch.trimmingCharacters(in: .whitespaces).prefix(100)) }
  var searching: Bool { !searchQuery.isEmpty }

  // Friends whose name or handle has the search in it, by name.
  var searchFriends: [Friend] {
    let query = searchQuery
    return byName(friends.filter {
      $0.displayName.localizedCaseInsensitiveContains(query) || $0.handle.localizedCaseInsensitiveContains(query)
    })
  }

  // Everyone you could message, by name, narrowed by the New chat filter.
  var newChatFriends: [Friend] {
    let filter = newChatFilter.trimmingCharacters(in: .whitespaces)
    return byName(friends.filter {
      filter.isEmpty || $0.displayName.localizedCaseInsensitiveContains(filter)
        || $0.handle.localizedCaseInsensitiveContains(filter)
    })
  }

  private func byName(_ list: [Friend]) -> [Friend] {
    list.sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
  }

  // What ↑/↓ moves through on the Chats tab: the New chat picker, search results (friends, then
  // messages as "m:" and their id), or the chats.
  var chatsList: [String] {
    if newChat { return newChatFriends.map(\.handle) }
    if searching { return searchFriends.map(\.handle) + searchResults.map { "m:\($0.id)" } }
    return chats.map(\.handle)
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
    // Friends right after setup, to find people; Chats on every launch after, for talking.
    if prefs.setupDone { tab = .chats }
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
    NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) {
      [weak self] _ in
      MainActor.assumeIsolated {
        NSTimeZone.resetSystemTimeZone()
        self?.timeZone = .current
      }
    }
    arrivals.settle(from: .now)
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.arrivals.settle(from: .now) }
    }
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
      // Back online: everyone's presence arrives again, and none of it is anyone arriving.
      if info.connection == "online", me?.connection != "online" { arrivals.settle(from: .now) }
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
    case .signedInElsewhere:
      signingIn = false
      loginCode = nil
      loginError = String(localized: "You signed in on another Mac.")
    case .settings(let s): settings = s
    case .tools(let t): tools = t
    case .roster(let r):
      let wasOnline = Dictionary(friends.map { ($0.handle, $0.isOnline) }, uniquingKeysWith: { first, _ in first })
      friends = r
      noticeArrivals(wasOnline)
      if let selected, !r.contains(where: { $0.handle == selected }) { self.selected = nil }
      readOpenChat()
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
      if ok, op == "reports.list" { waitingReports = data?.reports ?? [] }
      // Only the answer to what's in the field now; an older search can answer late.
      if ok, op == "search", let query = data?.query, query == searchQuery {
        searchResults = data?.messages ?? []
        searchedFor = query
      }
      // A friend you removed or blocked has no chat to stay in.
      if ok, op == "friend.remove" || op == "block" {
        chatWith = nil
        profileOf = nil
      }
    case .reports(let count, let crash, let since):
      reports = (count, crash, since)
      handleReports()
    case .ping(let n):
      // Straight to the socket: going through request() would touch observed state each time.
      let alert = NSApp.modalWindow
      client.send([
        "op": "pong", "n": n, "menuBar": prefs.menuBar, "expanded": expanded,
        "modal": alert != nil, "modalHidden": alert.map { !$0.occlusionState.contains(.visible) } ?? false,
      ])
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
    if alert.loud { lastAlert[message.peer] = now }
    // A nudge shakes Margin, even with their chat open.
    if Alerts.shakes(message, setting: prefs.nudges, paused: prefs.alertsPaused, lastShake: lastShake[message.peer], now: now) {
      lastShake[message.peer] = now
      shake += 1
    }
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
  // At most one to each friend every 45 seconds; margind says so in results["nudge"].
  func nudge(_ handle: String) {
    request("nudge", ["to": handle])
  }

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

  // Settings → Notifications → Friends coming online: who went offline, and who came online
  // worth a note. The first list from margind is where everyone already was.
  private func noticeArrivals(_ wasOnline: [String: Bool]) {
    guard !wasOnline.isEmpty else { return }
    let now = Date.now
    let start = arriving.isEmpty
    for friend in friends {
      guard let was = wasOnline[friend.handle], was != friend.isOnline else { continue }
      if !friend.isOnline {
        arrivals.left(friend.handle, at: now)
      } else if wantsArrival(friend.handle), arrivals.arrived(friend.handle, at: now) {
        arriving.append(friend.handle)
      }
    }
    guard start, !arriving.isEmpty else { return }
    Task {
      try? await Task.sleep(for: .seconds(Arrivals.batch))
      showArrivals()
    }
  }

  private func wantsArrival(_ handle: String) -> Bool {
    switch prefs.friendsOnline {
    case "everyone": true
    case "close": settings?.closeFriends.contains(handle) ?? false
    default: false
    }
  }

  // One note for everyone gathered who's still online. A message showing wins, and nothing
  // shows while alerts are paused or the drawer is open.
  private func showArrivals() {
    let handles = arriving.filter { friend($0)?.isOnline == true }
    arriving = []
    guard let first = handles.first.flatMap(friend), !prefs.alertsPaused, !expanded, peek == nil || peek?.online != nil,
      arrivals.show(handles, at: .now)
    else { return }
    let names = handles.compactMap(friend).map(\.displayName)
    let line =
      switch names.count {
      case 1: String(localized: "\(names[0]) is online")
      case 2: String(localized: "\(names[0]) and \(names[1]) are online")
      default: String(localized: "\(names[0]), \(names[1]) and \(names.count - 2) more are online")
      }
    peek = Peek(
      id: UUID().uuidString, handle: names.count == 1 ? first.handle : "", name: line,
      preview: names.count == 1 ? Alerts.doing(first.presence) : nil, online: first.presence.status)
  }

  // A chat on screen leaves nothing in it unread: when a message arrives in it, and when the
  // drawer opens back onto it after messages came while it was closed (it stays on that chat).
  private func readOpenChat() {
    guard expanded, let chatWith, (friend(chatWith)?.unread ?? 0) > 0 else { return }
    markRead(chatWith)
  }

  // ↑/↓ through the list on screen: friends, or chats.
  func moveSelection(_ delta: Int) {
    let handles = tab == .chats ? chatsList : (onlineFriends + offlineFriends).map(\.handle)
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
    newChat = false
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

  // `at` opens it on that message instead of the newest (a search result).
  func openChat(_ handle: String, at message: String? = nil) {
    if peek?.handle == handle { peek = nil }
    if profileOf != handle { profileOf = nil }
    if message == nil { selected = handle }
    newChat = false
    jumpTo = message
    chatWith = handle
    cursor = nil
    request("history", message.map { ["with": handle, "around": $0] } ?? ["with": handle])
    markRead(handle)
  }

  // Return on the Chats tab: the outlined row, or from a field with nothing outlined, the first.
  func openSelected(orFirst: Bool) {
    let list = chatsList
    guard let item = keyboardNav ? selected.flatMap({ list.contains($0) ? $0 : nil }) : (orFirst ? list.first : nil)
    else { return }
    if item.hasPrefix("m:") {
      let id = String(item.dropFirst(2))
      guard let message = searchResults.first(where: { $0.id == id }) else { return }
      selected = item
      openChat(message.peer, at: id)
    } else {
      openChat(item)
    }
  }

  func startNewChat() {
    showTab(.chats)
    newChatFilter = ""
    newChat = true
    selected = nil
  }

  func searchChats() {
    showTab(.chats)
    wantsSearchFocus = true
  }

  // Esc on the Chats tab: out of New chat, then out of search; false when there's neither.
  func leaveChatsMode() -> Bool {
    if newChat {
      newChat = false
    } else if !chatSearch.isEmpty {
      chatSearch = ""
    } else {
      return false
    }
    selected = nil
    return true
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

  // Always send, never send, or ask: straight away after a crash, and in the drawer about
  // errors that aren't crashes (see checkWaitingErrors).
  private func handleReports() {
    checkWaitingErrors()
    guard reports.count > 0 else { return }
    switch prefs.crashReports {
    case "always": request("reports.send")
    case "never": request("reports.discard")
    default: if reports.crash, !askingAboutReports { askAboutReports() }
    }
  }

  // Errors are asked about once the oldest has waited three hours, so a burst is one question,
  // and at most once a day. A crash waiting is asked about by itself, and the errors go with it.
  private func checkWaitingErrors() {
    let now = Date.now
    askAboutErrors =
      prefs.crashReports == "ask" && reports.count > 0 && !reports.crash
      && reports.since.map { now.timeIntervalSince($0) >= 3 * 3600 } ?? false
      && prefs.reportsAnsweredAt.map { now.timeIntervalSince($0) >= 24 * 3600 } ?? true
  }

  func answerWaitingErrors(send: Bool, always: Bool = false) {
    if always { prefs.crashReports = "always" }
    prefs.reportsAnsweredAt = .now
    askAboutErrors = false
    waitingReports = nil
    request(send ? "reports.send" : "reports.discard")
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
    prefs.reportsAnsweredAt = .now
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
