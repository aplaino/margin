import SwiftUI

// Conversations, most recent first: who, the last thing said and when. Friends stays about
// who's around; this is where an old chat with someone offline is easy to find. Search across
// the top finds friends and messages on this Mac; the compose button starts a chat with anyone.
struct ChatsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @FocusState private var searchFocused: Bool

  var body: some View {
    if model.newChat {
      NewChatView()
    } else {
      @Bindable var model = model
      VStack(spacing: 0) {
        HStack(spacing: 6) {
          ChatsField(placeholder: "Search", text: $model.chatSearch, focused: $searchFocused)
          Button {
            model.startNewChat()
          } label: {
            Image(systemName: "square.and.pencil").font(theme.font(14)).foregroundStyle(theme.secondary)
              .frame(width: 26, height: 26).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .help("New Chat (⌘N)")
          .accessibilityLabel("New Chat")
        }
        .padding(.horizontal, 8).padding(.top, 8)
        TimelineView(.everyMinute) { context in
          ScrollViewReader { proxy in
            ScrollView {
              VStack(alignment: .leading, spacing: 2) {
                if model.searching { results(now: context.date) } else { chats(now: context.date) }
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
      .onAppear(perform: takeSearchFocus)
      .onChange(of: model.wantsSearchFocus, takeSearchFocus)
      // Waits a moment after typing, so each keystroke isn't a search.
      .task(id: model.searchQuery) {
        let query = model.searchQuery
        guard !query.isEmpty else {
          model.searchResults = []
          model.searchedFor = nil
          return
        }
        try? await Task.sleep(for: .milliseconds(200))
        guard !Task.isCancelled else { return }
        model.request("search", ["query": query])
      }
    }
  }

  @ViewBuilder private func chats(now: Date) -> some View {
    if model.chats.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text("No chats yet").font(theme.bodyBold)
        Button {
          model.startNewChat()
        } label: {
          Text("Pick a friend to send them a message")
        }
        .buttonStyle(.link).font(theme.small)
      }
      .padding(8)
    }
    ForEach(model.chats) { friend in
      if let last = model.latest[friend.handle] {
        ChatRow(friend: friend, last: last, now: now).id(friend.handle)
      }
    }
  }

  @ViewBuilder private func results(now: Date) -> some View {
    let friends = model.searchFriends
    if !friends.isEmpty {
      SectionLabel("Friends").padding(.leading, 8).padding(.top, 2)
      ForEach(friends) { friend in
        FriendPickRow(friend: friend).id(friend.handle)
      }
    }
    if !model.searchResults.isEmpty {
      SectionLabel("Messages").padding(.leading, 8).padding(.top, friends.isEmpty ? 2 : 10)
      ForEach(model.searchResults) { message in
        MessageResultRow(message: message, query: model.searchQuery, now: now).id("m:\(message.id)")
      }
    }
    if friends.isEmpty, model.searchResults.isEmpty, model.searchedFor == model.searchQuery {
      Text("No results").font(theme.small).foregroundStyle(theme.tertiary).padding(8)
    }
  }

  // ⌘F, or coming back to a search still typed in. A field takes the keyboard by itself only
  // while the drawer has it.
  private func takeSearchFocus() {
    guard model.wantsSearchFocus else { return }
    model.wantsSearchFocus = false
    searchFocused = model.drawerFocused
  }
}

// Every friend, to start (or go back to) a chat with, narrowed as you type.
struct NewChatView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @FocusState private var focused: Bool

  var body: some View {
    @Bindable var model = model
    let friends = model.newChatFriends
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Button {
          model.newChat = false
        } label: {
          Image(systemName: "chevron.left").font(theme.font(13, bold: true))
            .foregroundStyle(theme.secondary).frame(width: 22, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to chats")
        Text("New Chat").font(theme.bodyBold)
        Spacer()
      }
      .padding(.horizontal, 10).padding(.top, 8)
      ChatsField(placeholder: "Name or handle", text: $model.newChatFilter, focused: $focused)
        .padding(.horizontal, 8).padding(.top, 4)
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 2) {
            if model.friends.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                Text("No friends yet").font(theme.bodyBold)
                Button {
                  model.showTab(.add)
                } label: {
                  Text("Add a friend to message them")
                }
                .buttonStyle(.link).font(theme.small)
              }
              .padding(8)
            } else if friends.isEmpty {
              Text("Nobody matches.").font(theme.small).foregroundStyle(theme.tertiary).padding(8)
            }
            ForEach(friends) { friend in
              FriendPickRow(friend: friend).id(friend.handle)
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
    .onAppear { focused = model.drawerFocused }
  }
}

// The rounded field across the top of Chats and New chat, like Find friends'.
struct ChatsField: View {
  var placeholder: LocalizedStringKey
  @Binding var text: String
  var focused: FocusState<Bool>.Binding
  @Environment(\.theme) private var theme

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass").font(theme.small).foregroundStyle(theme.tertiary)
      TextField(placeholder, text: $text).textFieldStyle(.plain).focused(focused)
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill").font(theme.small).foregroundStyle(theme.tertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear")
      }
    }
    .padding(.horizontal, 10).padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: theme.nested(16)).fill(theme.surface))
    .overlay(RoundedRectangle(cornerRadius: theme.nested(16)).strokeBorder(theme.border, lineWidth: theme.borderWidth))
  }
}

struct ChatRow: View {
  var friend: Friend
  var last: ChatMessage
  var now: Date
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var hovering = false
  private var selected: Bool { model.keyboardNav && model.selected == friend.handle }

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
            // Not delivered, as in the chat.
            if last.failed {
              Image(systemName: "exclamationmark.circle.fill").font(theme.small).foregroundStyle(theme.danger)
                .accessibilityLabel("Not Delivered")
            }
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
      .listRow(theme, highlighted: hovering || selected, outlined: selected)
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

// A friend in search results or New chat: opens the chat with them.
struct FriendPickRow: View {
  var friend: Friend
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var hovering = false
  private var selected: Bool { model.keyboardNav && model.selected == friend.handle }

  var body: some View {
    Button {
      model.openChat(friend.handle)
    } label: {
      HStack(spacing: 9) {
        PresenceDot(status: friend.presence.status, size: theme.rowDot)
        VStack(alignment: .leading, spacing: 1) {
          Text(friend.displayName).font(theme.bodyBold).lineLimit(1)
          if friend.name != nil {
            Text(verbatim: "@\(friend.handle)").font(theme.caption).foregroundStyle(theme.secondary).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .listRow(theme, highlighted: hovering || selected, outlined: selected)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

// A message search found: who, when, and the words around the match.
struct MessageResultRow: View {
  var message: ChatMessage
  var query: String
  var now: Date
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var hovering = false
  private var id: String { "m:\(message.id)" }
  private var selected: Bool { model.keyboardNav && model.selected == id }

  var body: some View {
    let friend = model.friend(message.peer)
    Button {
      model.selected = id
      model.openChat(message.peer, at: message.id)
    } label: {
      HStack(alignment: .top, spacing: 9) {
        PresenceDot(status: friend?.presence.status ?? "offline", size: theme.rowDot).padding(.top, 5)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(friend?.displayName ?? message.peer).font(theme.bodyBold).lineLimit(1)
            Spacer(minLength: 4)
            Text(Format.ago(message.sentAt, now: now)).font(theme.caption).foregroundStyle(theme.tertiary)
              .lineLimit(1).fixedSize()
          }
          let snippet = Text(Format.snippet(message.text, matching: query))
          (message.incoming ? snippet : Text("You: \(snippet)"))
            .font(theme.small).foregroundStyle(theme.secondary).lineLimit(1)
        }
      }
      .listRow(theme, highlighted: hovering || selected, outlined: selected)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

extension View {
  // A row in the Chats lists: hover or keyboard highlight, and the accent outline for the latter.
  fileprivate func listRow(_ theme: Theme, highlighted: Bool, outlined: Bool) -> some View {
    padding(.horizontal, 8).padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: theme.nested(8)).fill(highlighted ? theme.hover : .clear))
      .overlay(RoundedRectangle(cornerRadius: theme.nested(8)).strokeBorder(outlined ? theme.accent : .clear, lineWidth: 1.5))
      .contentShape(Rectangle())
  }
}
