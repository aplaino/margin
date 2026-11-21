import SwiftUI

struct ChatView: View {
  var handle: String
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    let friend = model.friend(handle)
    let messages = model.conversations[handle] ?? []
    VStack(spacing: 0) {
      HStack(alignment: .center, spacing: 8) {
        Button {
          model.chatWith = nil
        } label: {
          Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
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
      }
      .padding(.horizontal, 10).padding(.vertical, 12)
      Divider().overlay(theme.divider)

      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 6) {
            if let first = messages.first {
              Text(Format.time(first.sentAt)).font(.system(size: 10.5)).foregroundStyle(theme.tertiary)
                .padding(.bottom, 4)
            }
            ForEach(messages) { message in
              bubble(message).id(message.id)
            }
          }
          .padding(12)
        }
        .defaultScrollAnchor(.bottom)
        .onChange(of: messages.count) {
          if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
        }
      }

      Divider().overlay(theme.divider)
      TextField("Message \(friend?.displayName ?? handle)", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...5)
        .focused($focused)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.border, lineWidth: 1))
        .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6)
        .onSubmit(send)
      if let error = model.results["send"], !error.ok {
        Text(error.message ?? "Couldn’t send").font(theme.caption).foregroundStyle(theme.danger)
          .padding(.bottom, 4)
      }
      Text("End-to-end encrypted").font(.system(size: 10)).foregroundStyle(theme.tertiary).padding(.bottom, 8)
    }
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
            topLeadingRadius: 13, bottomLeadingRadius: message.incoming ? 4 : 13,
            bottomTrailingRadius: message.incoming ? 13 : 4, topTrailingRadius: 13
          )
          .fill(message.incoming ? theme.surface : theme.accent))
      if message.state == "queued" {
        Text("Sending…").font(.system(size: 10)).foregroundStyle(theme.tertiary)
      }
    }
    .frame(maxWidth: 190, alignment: message.incoming ? .leading : .trailing)
    .frame(maxWidth: .infinity, alignment: message.incoming ? .leading : .trailing)
  }
}
