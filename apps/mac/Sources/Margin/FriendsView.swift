import SwiftUI

struct FriendsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    TimelineView(.everyMinute) { context in
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          if model.friends.isEmpty {
            empty("No friends yet", action: "Add someone by their GitHub handle") { model.tab = .add }
          } else {
            if model.onlineFriends.isEmpty {
              Text("Nobody’s online right now").font(theme.small).foregroundStyle(theme.secondary)
                .padding(.horizontal, 8).padding(.vertical, 10)
            }
            ForEach(model.onlineFriends) { friend in
              FriendRow(friend: friend, now: context.date)
            }
            if !model.offlineFriends.isEmpty {
              SectionLabel("Offline").padding(.horizontal, 8).padding(.top, 12).padding(.bottom, 4)
              ForEach(model.offlineFriends) { friend in
                OfflineRow(friend: friend, now: context.date)
              }
            }
          }
        }
        .padding(8)
      }
    }
  }

  private func empty(_ title: String, action: String, perform: @escaping () -> Void) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(theme.bodyBold)
      Button(action, action: perform).buttonStyle(.link).font(theme.small)
    }
    .padding(8)
  }
}

struct FriendRow: View {
  var friend: Friend
  var now: Date
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var hovering = false

  var body: some View {
    Button {
      model.openChat(friend.handle)
    } label: {
      HStack(alignment: .top, spacing: 9) {
        dot.padding(.top, 5)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(friend.displayName).font(theme.bodyBold).lineLimit(1)
            Spacer(minLength: 4)
            if let tokens = friend.presence.tokens {
              Text(Format.tokens(tokens)).font(theme.mono).foregroundStyle(theme.secondary)
            }
            if friend.unread > 0 {
              Text("\(friend.unread)").font(.system(size: 10, weight: .bold))
                .foregroundStyle(theme.onUnread)
                .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 16)
                .background(Capsule().fill(theme.unread))
            }
          }
          Text(Format.what(friend.presence)).font(theme.small).foregroundStyle(theme.secondary).lineLimit(1)
          let detail = Format.detail(friend.presence, now: now)
          if !detail.isEmpty {
            Text(detail).font(theme.mono).foregroundStyle(theme.tertiary).lineLimit(1)
          }
        }
      }
      .padding(.horizontal, 8).padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: theme.rowRadius).fill(hovering ? theme.hover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityLabel("\(friend.displayName), \(Format.what(friend.presence))")
  }

  @ViewBuilder private var dot: some View {
    if friend.presence.status == "idle" {
      HalfDot(color: theme.idle).frame(width: 7, height: 7)
    } else {
      Circle().fill(theme.inTool).frame(width: 7, height: 7)
    }
  }
}

struct OfflineRow: View {
  var friend: Friend
  var now: Date
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    Button {
      model.openChat(friend.handle)
    } label: {
      HStack(spacing: 9) {
        Circle().strokeBorder(theme.offline, lineWidth: 1).frame(width: 6, height: 6)
        Text(friend.displayName).lineLimit(1)
        Spacer(minLength: 4)
        if let tokens = friend.presence.tokens {
          Text(Format.tokens(tokens)).font(theme.mono)
        }
        let ago = Format.ago(friend.lastSeenAt, now: now)
        if !ago.isEmpty { Text("· \(ago)").font(theme.caption) }
        if friend.unread > 0 {
          Text("\(friend.unread)").font(.system(size: 10, weight: .bold)).foregroundStyle(theme.onUnread)
            .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 16).background(Capsule().fill(theme.unread))
        }
      }
      .font(.system(size: 12))
      .foregroundStyle(theme.secondary)
      .padding(.horizontal, 8).padding(.vertical, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
