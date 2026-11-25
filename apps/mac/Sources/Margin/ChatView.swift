import AppKit
import SwiftUI

struct ChatView: View {
  var handle: String
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var draft = ""
  @FocusState private var focused: Bool
  @State private var showingSafety = false
  // The search result this chat was opened at, outlined for a moment.
  @State private var found: String?
  private static let end = "end"
  // Whether the bottom of the chat is in view (or nearly), as you last scrolled.
  @State private var atBottom = true

  var body: some View {
    let friend = model.friend(handle)
    let messages = model.conversations[handle] ?? []
    VStack(spacing: 0) {
      HStack(alignment: .center, spacing: 8) {
        Button {
          model.chatWith = nil
        } label: {
          Image(systemName: "chevron.left").font(theme.font(13, bold: true))
            .foregroundStyle(theme.secondary).frame(width: 22, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to friends")
        VStack(alignment: .leading, spacing: 2) {
          Button {
            model.openProfile(handle)
          } label: {
            Text(friend?.displayName ?? handle).font(theme.bodyBold)
          }
          .buttonStyle(.plain)
          .accessibilityHint("Shows their profile")
          if let friend {
            Group {
              let ago = Format.ago(friend.lastSeenAt)
              if friend.isOnline || ago.isEmpty {
                Text(Format.what(friend.presence))
              } else {
                Text("offline · last seen \(ago)")
              }
            }
            .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
            if let tokens = friend.presence.tokens {
              Text("\(Format.tokens(tokens)) tokens").font(theme.mono).foregroundStyle(theme.tertiary)
            }
          }
        }
        Spacer()
        Menu {
          Button("Safety Number") { showSafety() }
          Divider()
          Button("Delete Conversation…") { model.deleteConversation(handle) }
          Button("Remove Friend…") { confirm(.remove, friend?.displayName ?? handle) }
          Button("Block…") { confirm(.block, friend?.displayName ?? handle) }
          Button("Report…") { report(friend?.displayName ?? handle) }
        } label: {
          Image(systemName: "ellipsis.circle").font(theme.font(14)).foregroundStyle(theme.secondary)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("Actions for \(friend?.displayName ?? handle)")
      }
      .padding(.horizontal, 10).padding(.vertical, 12)
      if showingSafety { safetyNumber(friend?.displayName ?? handle) }
      Divider().overlay(theme.divider)

      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 0) {
            VStack(spacing: 6) {
              ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                // When each stretch of conversation began, as in Messages.
                if Format.startsSegment(message.sentAt, after: index > 0 ? messages[index - 1].sentAt : nil, in: model.timeZone) {
                  Text(Format.time(message.sentAt, in: model.timeZone)).font(theme.font(10.5)).foregroundStyle(theme.tertiary)
                    .padding(.top, index > 0 ? 8 : 0).padding(.bottom, 4)
                }
                bubble(message).id(message.id)
              }
            }
            .padding(12)
            // Below the padding, so scrolling here clears the fade with the last status line.
            Color.clear.frame(height: 0).id(ChatView.end)
          }
        }
        .edgeFade(10)
        .defaultScrollAnchor(.bottom)
        .onScrollGeometryChange(for: Bool.self) { geometry in
          geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 60
        } action: { _, near in
          atBottom = near
        }
        .onAppear { jump(proxy, in: messages) }
        // Your own message always brings the chat to the bottom; theirs, and a status line
        // under yours, only while you're there already, not while you've scrolled up to read.
        .onChange(of: messages.count) {
          if jump(proxy, in: messages) { return }
          if atBottom || messages.last?.incoming == false { proxy.scrollTo(ChatView.end, anchor: .bottom) }
        }
        .onChange(of: messages.last?.state) {
          if atBottom { proxy.scrollTo(ChatView.end, anchor: .bottom) }
        }
        .onChange(of: messages.last?.preview?.url) {
          if atBottom { proxy.scrollTo(ChatView.end, anchor: .bottom) }
        }
        .onChange(of: model.cursor) {
          if let cursor = model.cursor { proxy.scrollTo(cursor) }
        }
      }

      Divider().overlay(theme.divider)
      HStack(alignment: .bottom, spacing: 6) {
        TextField("Message \(friend?.displayName ?? handle)", text: $draft, axis: .vertical)
          .textFieldStyle(.plain)
          .lineLimit(1...5)
          .focused($focused)
          .padding(.horizontal, 10).padding(.vertical, 8)
          .background(RoundedRectangle(cornerRadius: theme.nested(10)).fill(theme.surface))
          .overlay(RoundedRectangle(cornerRadius: theme.nested(10)).strokeBorder(theme.border, lineWidth: theme.borderWidth))
          .onSubmit(send)
          .onAppear { focused = model.drawerFocused }
        Button {
          model.nudge(handle)
        } label: {
          Image(systemName: "hand.wave").font(theme.font(14)).foregroundStyle(theme.secondary)
            .frame(width: 24, height: 32).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Nudge \(friend?.displayName ?? handle) (or type /nudge)")
        .accessibilityLabel("Nudge \(friend?.displayName ?? handle)")
      }
      .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6)
      if let error = model.results["unsend"], !error.ok {
        (error.message.map { Text(verbatim: $0) } ?? Text("Couldn’t unsend")).font(theme.caption).foregroundStyle(theme.danger)
          .padding(.bottom, 4)
      }
      if let error = model.results["retry"], !error.ok {
        (error.message.map { Text(verbatim: $0) } ?? Text("Couldn’t send")).font(theme.caption).foregroundStyle(theme.danger)
          .padding(.bottom, 4)
      }
      if let refused = model.nudgeRefused, refused.handle == handle {
        Text(verbatim: refused.message).font(theme.caption).foregroundStyle(theme.danger)
          .padding(.bottom, 4)
      }
      if let error = model.results["send"], !error.ok {
        (error.message.map { Text(verbatim: $0) } ?? Text("Couldn’t send")).font(theme.caption).foregroundStyle(theme.danger)
          .padding(.bottom, 4)
      }
      Text("End-to-end encrypted").font(theme.font(10)).foregroundStyle(theme.tertiary).padding(.bottom, 8)
    }
  }

  private func showSafety() {
    showingSafety = true
    model.safety[handle] = nil
    model.request("safety", ["handle": handle])
  }

  // The same digits show on both Macs when nobody is in between; compared out loud, they
  // prove the chat is with this person.
  private func safetyNumber(_ name: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("Safety number").font(theme.bodyBold)
        Spacer()
        Button("Done") { showingSafety = false }.buttonStyle(.link)
      }
      if let number = model.safety[handle] {
        Text(verbatim: Self.lines(number)).font(theme.font(15, bold: true).monospaced()).textSelection(.enabled)
          .fixedSize()
        Text("Compare it with \(name) in person or on a call. If both of you see the same digits, your messages are only readable by the two of you.")
          .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      } else if let result = model.results["safety"], !result.ok {
        (result.message.map { Text(verbatim: $0) } ?? Text("Couldn’t get the safety number")).font(theme.caption).foregroundStyle(theme.danger)
      } else {
        Text("Working it out…").font(theme.caption).foregroundStyle(theme.secondary)
      }
    }
    .padding(.horizontal, 12).padding(.bottom, 10)
  }

  // Twelve groups of five, four to a line.
  static func lines(_ number: String) -> String {
    let groups = number.split(separator: " ")
    return stride(from: 0, to: groups.count, by: 4)
      .map { groups[$0..<min($0 + 4, groups.count)].joined(separator: " ") }
      .joined(separator: "\n")
  }

  private enum Action { case remove, block }

  private func confirm(_ action: Action, _ name: String) {
    NSApp.activate()
    let alert = NSAlert()
    switch action {
    case .remove:
      alert.messageText = String(localized: "Remove \(name) as a friend?")
      alert.informativeText = String(localized: "You’ll stop seeing each other’s activity and can’t message until one of you adds the other again. Your chat history stays on this Mac.")
      alert.addButton(withTitle: String(localized: "Remove"))
    case .block:
      alert.messageText = String(localized: "Block \(name)?")
      alert.informativeText = String(localized: "You’ll stop being friends, they can’t message you or find you, and anything they sent that you haven’t received is deleted. To them it looks as if you’re not on Margin. You can unblock in Settings → Privacy.")
      alert.addButton(withTitle: String(localized: "Block"))
    }
    alert.addButton(withTitle: String(localized: "Cancel"))
    alert.buttons.first?.hasDestructiveAction = true
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    model.request(action == .remove ? "friend.remove" : "block", ["handle": handle])
  }

  private func report(_ name: String) {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = String(localized: "Report \(name)?")
    alert.informativeText = String(localized: "Reports go to whoever runs Margin, with your handle and theirs and the reason you give. Messages stay encrypted and aren’t included.")
    let reason = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    reason.placeholderString = String(localized: "What happened (optional)")
    alert.accessoryView = reason
    alert.showsSuppressionButton = true
    alert.suppressionButton?.title = String(localized: "Also block \(name)")
    alert.addButton(withTitle: String(localized: "Report"))
    alert.addButton(withTitle: String(localized: "Cancel"))
    alert.window.initialFirstResponder = reason
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let text = String(reason.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
    model.request("report", ["handle": handle, "reason": text.isEmpty ? "No reason given" : text])
    if alert.suppressionButton?.state == .on { model.request("block", ["handle": handle]) }
  }

  // Once the chat holds the search result it was opened at: scrolled to the middle and
  // outlined for a moment, as in Messages.
  @discardableResult private func jump(_ proxy: ScrollViewProxy, in messages: [ChatMessage]) -> Bool {
    guard let id = model.jumpTo, messages.contains(where: { $0.id == id }) else { return false }
    model.jumpTo = nil
    // After the scroll view's own move to the bottom on appearing.
    DispatchQueue.main.async { proxy.scrollTo(id, anchor: .center) }
    found = id
    Task {
      try? await Task.sleep(for: .seconds(1.6))
      withAnimation(.easeOut(duration: 0.6)) { if found == id { found = nil } }
    }
    return true
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    if text.lowercased() == "/nudge" { model.nudge(handle) } else { model.send(text, to: handle) }
    draft = ""
    focused = true
  }

  // An unsent message leaves a quiet line where it was, as in Messages; a nudge is one too.
  @ViewBuilder private func bubble(_ message: ChatMessage) -> some View {
    if message.unsent {
      let name = model.friend(handle)?.displayName ?? handle
      Text(message.incoming ? "\(name) unsent a message" : "You unsent a message")
        .font(theme.font(10.5)).foregroundStyle(theme.tertiary)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity)
        .overlay {
          RoundedRectangle(cornerRadius: theme.controlRadius + 3)
            .strokeBorder(model.keyboardNav && model.cursor == message.id || found == message.id ? theme.accent : .clear, lineWidth: 1.5)
        }
        .contextMenu {
          Button("Delete…") { model.delete(message) }
        }
    } else if message.nudge {
      // A nudge is a line in the chat, as in MSN; one the server refused says so.
      let name = model.friend(handle)?.displayName ?? handle
      HStack(spacing: 4) {
        Image(systemName: "hand.wave").font(theme.font(10))
        Text(message.incoming ? "\(name) sent you a nudge" : "You sent a nudge")
        if message.failed { Text("Not Delivered").foregroundStyle(theme.danger) }
      }
        .font(theme.font(10.5)).foregroundStyle(theme.tertiary)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity)
        .overlay {
          RoundedRectangle(cornerRadius: theme.controlRadius + 3)
            .strokeBorder(model.keyboardNav && model.cursor == message.id || found == message.id ? theme.accent : .clear, lineWidth: 1.5)
        }
        .contextMenu {
          Button("Delete…") { model.delete(message) }
        }
    } else {
      sentBubble(message)
    }
  }

  // "Sending…" on anything still waiting to leave this Mac; "Delivered" or "Read 2:14 PM"
  // under your latest message while it's the last in the chat, as in Messages. With read
  // receipts off, theirs show as delivered. A refused one says "Not Delivered", in red.
  private func status(_ message: ChatMessage) -> LocalizedStringResource? {
    if message.state == "queued" { return "Sending…" }
    if message.failed { return "Not Delivered" }
    guard !message.incoming, message.id == (model.conversations[handle] ?? []).last?.id else { return nil }
    switch message.state {
    case "read" where model.settings?.readReceipts ?? true:
      return "Read \(Format.readTime(message.readAt ?? message.sentAt, in: model.timeZone))"
    case "read", "delivered": return "Delivered"
    default: return nil
    }
  }

  // Picture, title, a line of detail and the site; the whole card opens the link, whose
  // address margind has checked is in the message.
  private func previewCard(_ preview: LinkPreview) -> some View {
    Button {
      if let url = URL(string: preview.url), url.scheme == "https" { NSWorkspace.shared.open(url) }
    } label: {
      HStack(alignment: .top, spacing: 8) {
        if let image = preview.image.flatMap(LinkPreviews.image) {
          Image(nsImage: image).resizable().scaledToFill()
            .frame(width: 40, height: 40)
            .clipShape(RoundedRectangle(cornerRadius: theme.nested(10)))
        }
        VStack(alignment: .leading, spacing: 1) {
          Text(verbatim: preview.title).font(theme.font(12, bold: true)).lineLimit(2)
          if let detail = preview.detail {
            Text(verbatim: detail).font(theme.caption).foregroundStyle(theme.secondary).lineLimit(2)
          }
          // The host the card really opens, not the name the sender's page gave itself.
          if let host = URL(string: preview.url)?.host() {
            Text(verbatim: host.hasPrefix("www.") ? String(host.dropFirst(4)) : host)
              .font(theme.font(10)).foregroundStyle(theme.tertiary).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(8)
      .foregroundStyle(theme.text)
      .background(RoundedRectangle(cornerRadius: theme.bubbleRadius).fill(theme.surface))
      .overlay(RoundedRectangle(cornerRadius: theme.bubbleRadius).strokeBorder(theme.border, lineWidth: theme.borderWidth))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(preview.url)
  }

  // Beside a refused message, as in Messages: Try Again or Delete.
  private func notDelivered(_ message: ChatMessage) -> some View {
    Menu {
      Button("Try Again") { model.tryAgain(message) }
      Button("Delete…") { model.delete(message) }
    } label: {
      Image(systemName: "exclamationmark.circle.fill").font(theme.font(14)).foregroundStyle(theme.danger)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .accessibilityLabel("Not Delivered")
    .transition(.blurReplace)
  }

  private func sentBubble(_ message: ChatMessage) -> some View {
    VStack(alignment: message.incoming ? .leading : .trailing, spacing: 2) {
      if let preview = message.preview { previewCard(preview) }
      HStack(spacing: 6) {
        if message.failed { notDelivered(message) }
        textBubble(message)
      }
      if let status = status(message) {
        Text(status).font(theme.font(10)).foregroundStyle(message.failed ? theme.danger : theme.tertiary)
          .id(message.state)
          .transition(.blurReplace)
      }
    }
    .animation(.smooth(duration: 0.2), value: message.state)
    .frame(maxWidth: 190, alignment: message.incoming ? .leading : .trailing)
    .frame(maxWidth: .infinity, alignment: message.incoming ? .leading : .trailing)
  }

  private func textBubble(_ message: ChatMessage) -> some View {
    Text(LinkPreviews.attributed(message.text))
      .tint(message.incoming ? theme.accent : theme.onAccent)
      .help(LinkPreviews.links(in: message.text).map(\.url.absoluteString).joined(separator: "\n"))
      .textSelection(.enabled)
      .padding(.horizontal, 11).padding(.vertical, 7)
      .foregroundStyle(message.incoming ? theme.text : theme.onAccent)
      .background(
        UnevenRoundedRectangle(
          topLeadingRadius: theme.bubbleRadius,
          bottomLeadingRadius: message.incoming ? min(4, theme.bubbleRadius) : theme.bubbleRadius,
          bottomTrailingRadius: message.incoming ? theme.bubbleRadius : min(4, theme.bubbleRadius),
          topTrailingRadius: theme.bubbleRadius
        )
        .fill(message.incoming ? theme.surface : theme.accent))
      .overlay {
        RoundedRectangle(cornerRadius: theme.bubbleRadius + 3)
          .strokeBorder(model.keyboardNav && model.cursor == message.id || found == message.id ? theme.accent : .clear, lineWidth: 1.5)
          .padding(-3)
      }
      .contextMenu {
        Button("Copy") { model.copy(message) }
        if message.failed {
          Button("Try Again") { model.tryAgain(message) }
        }
        if message.canUndoSend {
          Button("Undo Send") { model.undoSend(message) }
        }
        Divider()
        Button("Delete…") { model.delete(message) }
      }
  }
}
