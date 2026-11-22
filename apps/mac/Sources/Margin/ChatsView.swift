import SwiftUI

// Conversations, most recent first: who, the last thing said and when. Friends stays about
// who's around; this is where an old chat with someone offline is easy to find.
struct ChatsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    TimelineView(.everyMinute) { context in
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 2) {
            if model.chats.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                Text("No chats yet").font(theme.bodyBold)
                Button {
                  model.showTab(.friends)
                } label: {
                  Text("Pick a friend to send them a message")
                }
                .buttonStyle(.link).font(theme.small)
              }
              .padding(8)
            }
            ForEach(model.chats) { friend in
              if let last = model.latest[friend.handle] {
                ChatRow(friend: friend, last: last, now: context.date).id(friend.handle)
              }
            }
          }
          .padding(8)
        }
        .edgeFade(8)
        .onChange(of: model.selected) {
          if let selected = model.selected { proxy.scrollTo(selected) }
        }
      }
    }
  }
}

struct ChatRow: View {
  var friend: Friend
  var last: ChatMessage
  var now: Date
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var hovering = false
  private var selected: Bool { model.selected == friend.handle }

  var body: some View {
    Button {
      model.openChat(friend.handle)
    } label: {
      HStack(alignment: .top, spacing: 9) {
        PresenceDot(status: friend.presence.status, size: theme.rowDot).padding(.top, 5)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(friend.displayName).font(theme.bodyBold).lineLimit(1)
            Spacer(minLength: 4)
            Text(Format.ago(last.sentAt, now: now)).font(theme.caption).foregroundStyle(theme.tertiary)
              .lineLimit(1).fixedSize()
          }
          HStack(spacing: 6) {
            preview.font(theme.small).foregroundStyle(friend.unread > 0 ? theme.text : theme.secondary)
              .lineLimit(1)
            Spacer(minLength: 4)
            if friend.unread > 0 {
              Text("\(friend.unread)").font(theme.font(10, bold: true))
                .contentTransition(.numericText(value: Double(friend.unread)))
                .animation(.smooth, value: friend.unread)
                .foregroundStyle(theme.onUnread)
                .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 16)
                .background(Capsule().fill(theme.unread))
            }
          }
        }
      }
      .padding(.horizontal, 8).padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: theme.nested(8)).fill(hovering || selected ? theme.hover : .clear))
      .overlay(RoundedRectangle(cornerRadius: theme.nested(8)).strokeBorder(selected ? theme.accent : .clear, lineWidth: 1.5))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }

  // The last message on one line; yours start with "You:".
  private var preview: Text {
    if last.unsent {
      return last.incoming ? Text("\(friend.displayName) unsent a message") : Text("You unsent a message")
    }
    let text = last.text.replacingOccurrences(of: "\n", with: " ")
    return last.incoming ? Text(verbatim: text) : Text("You: \(text)")
  }
}
