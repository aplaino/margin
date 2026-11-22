import SwiftUI

// The strip laid out for the menu bar: a dot per online friend (● in a tool, ◐ idle), +N past
// six so it stays narrow enough for a notched menu bar, and the unread count. With nobody
// online it shows one dim dot so it's still there to click. It's drawn into the menu bar
// item's image (macOS 26 hosts menu bar items in another process, where views inside them
// get clipped and miss clicks), so a pulse is drawn again with and without the glow.
struct MenuBarView: View {
  // 0 to 1, how bright the new-message glow is in this frame.
  var glow: Double = 0
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  static let maxDots = 6

  var body: some View {
    let online = model.onlineFriends
    let connected = model.me?.connection == "online"
    HStack(spacing: 4) {
      if !model.signedIn {
        Circle().strokeBorder(.primary.opacity(0.6), lineWidth: 1).frame(width: 7, height: 7)
      } else if online.isEmpty {
        Circle().fill(.primary.opacity(0.3)).frame(width: 7, height: 7)
      } else {
        ForEach(online.prefix(Self.maxDots)) { friend in
          dot(friend).opacity(connected ? 1 : 0.35)
        }
        if online.count > Self.maxDots {
          Text("+\(online.count - Self.maxDots)").font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.primary).fixedSize()
        }
      }
      if model.signedIn, model.unreadTotal > 0 {
        Text(model.unreadTotal > 9 ? "9+" : "\(model.unreadTotal)").font(.system(size: 9, weight: .bold))
          .foregroundStyle(theme.onUnread).fixedSize()
          .padding(.horizontal, 4).frame(minWidth: 14, minHeight: 14)
          .background(Capsule().fill(theme.unread))
      }
    }
    .padding(.horizontal, 3)
    .frame(height: 18)
    .shadow(color: theme.unread.opacity(0.9 * glow), radius: 4 * glow)
  }

  @ViewBuilder private func dot(_ friend: Friend) -> some View {
    if friend.presence.status == "idle" {
      HalfDot(color: theme.idle).frame(width: 7, height: 7)
    } else {
      Circle().fill(theme.inTool).frame(width: 7, height: 7)
    }
  }
}
