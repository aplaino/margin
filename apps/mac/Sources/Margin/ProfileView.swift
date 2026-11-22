import SwiftUI

// You, as your friends see you: name, handle, token total and friends, your row exactly as it
// goes out (close friends and everyone else can differ), and whether people can find you.
struct ProfileView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var asCloseFriend = false

  var body: some View {
    let me = model.me
    let handle = me?.handle ?? ""
    let closeOnly = model.settings?.audience == "close"
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Button {
          model.showProfile = false
        } label: {
          Image(systemName: "chevron.left").font(theme.font(13, bold: true))
            .foregroundStyle(theme.secondary).frame(width: 22, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back")
        Text("Profile").font(theme.bodyBold)
        Spacer()
      }
      .padding(.horizontal, 10).padding(.vertical, 12)
      Divider().overlay(theme.divider)

      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text(me?.name ?? handle).font(theme.title)
            if me?.name != nil { Text("@\(handle)").foregroundStyle(theme.secondary) }
            status(me?.presence).padding(.top, 4)
          }
          HStack(spacing: 18) {
            stat(Format.tokens(me?.tokens), "tokens, all time")
            stat("\(model.friends.count)", model.friends.count == 1 ? "friend" : "friends")
            stat("\(model.onlineFriends.count)", "online now")
          }

          SectionLabel("What friends see").padding(.top, 6)
          if closeOnly {
            Picker("Seen by", selection: $asCloseFriend) {
              Text("Everyone").tag(false)
              Text("Close friends").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden()
            .control("Seen by", choice: $asCloseFriend, from: [false, true])
          }
          if let presence = (closeOnly && !asCloseFriend ? me?.basic : me?.presence) {
            FriendRow(
              friend: Friend(
                handle: handle, name: me?.name, presence: presence, lastSeenAt: 0, unread: 0),
              now: .now
            )
            .allowsHitTesting(false)
            .background(RoundedRectangle(cornerRadius: theme.rowRadius).fill(theme.surface))
          } else {
            Text("Nothing yet. It appears once you’re connected.").font(theme.caption).foregroundStyle(theme.tertiary)
          }
          Text(
            closeOnly
              ? "Close friends see your activity; everyone else only sees online or idle."
              : "Every friend sees this. Change what’s shared in Settings → Privacy."
          )
          .font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)

          SectionLabel("Find friends").padding(.top, 6)
          Check(
            "Show me in Find friends",
            isOn: Binding(
              get: { model.settings?.findable ?? true },
              set: { on in model.updateSettings { $0.findable = on } }))
          Text("People on Margin can find you by your handle or name and send a request. Your activity is never shown there.")
            .font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)

          Button("Privacy settings") {
            model.showProfile = false
            model.showTab(.settings)
            model.settingsPage = .privacy
          }
          .buttonStyle(.link)
          .control("Privacy settings") {
            model.showProfile = false
            model.showTab(.settings)
            model.settingsPage = .privacy
          }
          .padding(.top, 4)
        }
        .toggleStyle(.checkbox)
        .controlSize(.small)
        .font(theme.font(12))
        .padding(16)
      }
    }
  }

  // Your own status, as close friends see it, under your name.
  @ViewBuilder private func status(_ presence: Presence?) -> some View {
    if model.settings?.invisible == true {
      Label {
        Text("Invisible — friends see you as offline")
      } icon: {
        PresenceDot(.offline, size: theme.rowDot)
      }
      .font(theme.small).foregroundStyle(theme.secondary)
    } else if let presence, presence.status != "offline" {
      HStack(spacing: 6) {
        PresenceDot(status: presence.status, size: theme.rowDot)
        let detail = Format.detail(presence)
        Text([Format.what(presence), detail].filter { !$0.isEmpty }.joined(separator: " · "))
          .lineLimit(2)
      }
      .font(theme.small).foregroundStyle(theme.secondary)
    } else {
      Text(model.me?.connection == "online" ? "Offline" : "Connecting…")
        .font(theme.small).foregroundStyle(theme.tertiary)
    }
  }

  private func stat(_ value: String, _ label: String) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(value).font(theme.bodyBold)
      Text(label).font(theme.caption).foregroundStyle(theme.secondary)
    }
  }
}
