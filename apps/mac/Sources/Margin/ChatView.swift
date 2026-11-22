import AppKit
import SwiftUI

struct ChatView: View {
  var handle: String
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var draft = ""
  @FocusState private var focused: Bool
  @State private var showingSafety = false

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
          Text(friend?.displayName ?? handle).font(theme.bodyBold)
          if let friend {
            Text(Format.what(friend.presence)).font(theme.caption).foregroundStyle(theme.secondary).lineLimit(1)
            if let tokens = friend.presence.tokens {
              Text("\(Format.tokens(tokens)) tokens").font(theme.mono).foregroundStyle(theme.tertiary)
            }
          }
        }
        Spacer()
        Menu {
          Button("Safety Number") {
            showingSafety = true
            model.request("safety", ["handle": handle])
          }
          Divider()
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
          VStack(spacing: 6) {
            if let first = messages.first {
              Text(Format.time(first.sentAt)).font(theme.font(10.5)).foregroundStyle(theme.tertiary)
                .padding(.bottom, 4)
            }
            ForEach(messages) { message in
              bubble(message).id(message.id)
            }
          }
          .padding(12)
        }
        .edgeFade(10)
        .defaultScrollAnchor(.bottom)
        .onChange(of: messages.count) {
          if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
        }
        .onChange(of: model.cursor) {
          if let cursor = model.cursor { proxy.scrollTo(cursor) }
        }
      }

      Divider().overlay(theme.divider)
      TextField("Message \(friend?.displayName ?? handle)", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...5)
        .focused($focused)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: theme.nested(10)).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: theme.nested(10)).strokeBorder(theme.border, lineWidth: theme.borderWidth))
        .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6)
        .onSubmit(send)
        .onAppear { focused = model.drawerFocused }
      if let error = model.results["send"], !error.ok {
        Text(error.message ?? "Couldn’t send").font(theme.caption).foregroundStyle(theme.danger)
          .padding(.bottom, 4)
      }
      Text("End-to-end encrypted").font(theme.font(10)).foregroundStyle(theme.tertiary).padding(.bottom, 8)
    }
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
        Text(number).font(theme.font(15, bold: true).monospaced()).textSelection(.enabled)
        Text("Compare it with \(name) in person or on a call. If both of you see the same digits, your messages are only readable by the two of you.")
          .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      } else if let result = model.results["safety"], !result.ok {
        Text(result.message ?? "Couldn’t get the safety number").font(theme.caption).foregroundStyle(theme.danger)
      } else {
        Text("Working it out…").font(theme.caption).foregroundStyle(theme.secondary)
      }
    }
    .padding(.horizontal, 12).padding(.bottom, 10)
  }

  private enum Action { case remove, block }

  private func confirm(_ action: Action, _ name: String) {
    NSApp.activate()
    let alert = NSAlert()
    switch action {
    case .remove:
      alert.messageText = "Remove \(name) as a friend?"
      alert.informativeText = "You’ll stop seeing each other’s activity and can’t message until one of you adds the other again. Your chat history stays on this Mac."
      alert.addButton(withTitle: "Remove")
    case .block:
      alert.messageText = "Block \(name)?"
      alert.informativeText = "You’ll stop being friends, they can’t message you or find you, and anything they sent that you haven’t received is deleted. To them it looks as if you’re not on Margin. You can unblock in Settings → Privacy."
      alert.addButton(withTitle: "Block")
    }
    alert.addButton(withTitle: "Cancel")
    alert.buttons.first?.hasDestructiveAction = true
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    model.request(action == .remove ? "friend.remove" : "block", ["handle": handle])
  }

  private func report(_ name: String) {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = "Report \(name)?"
    alert.informativeText = "Reports go to whoever runs Margin, with your handle and theirs and the reason you give. Messages stay encrypted and aren’t included."
    let reason = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    reason.placeholderString = "What happened (optional)"
    alert.accessoryView = reason
    alert.showsSuppressionButton = true
    alert.suppressionButton?.title = "Also block \(name)"
    alert.addButton(withTitle: "Report")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = reason
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let text = String(reason.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
    model.request("report", ["handle": handle, "reason": text.isEmpty ? "No reason given" : text])
    if alert.suppressionButton?.state == .on { model.request("block", ["handle": handle]) }
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.request("send", ["to": handle, "text": text])
    draft = ""
    focused = true
  }

  private func bubble(_ message: ChatMessage) -> some View {
    VStack(alignment: message.incoming ? .leading : .trailing, spacing: 2) {
      Text(message.text)
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
            .strokeBorder(model.cursor == message.id ? theme.accent : .clear, lineWidth: 1.5)
            .padding(-3)
        }
        .contextMenu {
          Button("Copy") { model.copy(message) }
        }
      if message.state == "queued" {
        Text("Sending…").font(theme.font(10)).foregroundStyle(theme.tertiary)
      }
    }
    .frame(maxWidth: 190, alignment: message.incoming ? .leading : .trailing)
    .frame(maxWidth: .infinity, alignment: message.incoming ? .leading : .trailing)
  }
}
