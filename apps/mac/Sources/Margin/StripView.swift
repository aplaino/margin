import SwiftUI

// The always-visible strip: a dot per online friend (● in a tool, ◐ idle), +N past 12, and
// the unread count. A new message pulses it once.
struct StripView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var glow = false

  private let maxDots = 12

  var body: some View {
    let online = model.onlineFriends
    let connected = model.me?.connection == "online"
    VStack(spacing: theme.stripSpacing) {
      if !model.signedIn {
        Circle().strokeBorder(theme.offline, lineWidth: 1).frame(width: theme.dot, height: theme.dot)
      } else {
        ForEach(online.prefix(maxDots)) { friend in
          dot(friend).opacity(connected ? 1 : 0.35)
        }
        if online.count > maxDots {
          Text("+\(online.count - maxDots)").font(.system(size: 6.5, weight: .semibold))
            .foregroundStyle(theme.secondary).fixedSize().frame(height: theme.stripLabel)
        }
        if model.unreadTotal > 0 {
          Text("\(min(model.unreadTotal, 99))").font(.system(size: 7, weight: .bold))
            .foregroundStyle(theme.unread).fixedSize().frame(height: theme.stripLabel)
        }
      }
    }
    .padding(.vertical, theme.stripPadding)
    .frame(width: theme.stripWidth)
    .frame(minHeight: 32)
    .background(shape.fill(theme.background))
    .overlay(shape.strokeBorder(theme.border, lineWidth: 1))
    .shadow(color: theme.unread.opacity(glow ? 0.9 : 0), radius: glow ? 6 : 0)
    .onChange(of: model.pulse) {
      withAnimation(.easeOut(duration: 0.2)) { glow = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        withAnimation(.easeIn(duration: 0.2)) { glow = false }
      }
    }
    .accessibilityElement()
    .accessibilityLabel("Margin: \(online.count) friends online, \(model.unreadTotal) unread")
    .accessibilityAddTraits(.isButton)
  }

  private var shape: UnevenRoundedRectangle {
    model.prefs.edge == "left"
      ? UnevenRoundedRectangle(bottomTrailingRadius: 5, topTrailingRadius: 5)
      : UnevenRoundedRectangle(topLeadingRadius: 5, bottomLeadingRadius: 5)
  }

  @ViewBuilder private func dot(_ friend: Friend) -> some View {
    if friend.presence.status == "idle" {
      HalfDot(color: theme.idle).frame(width: theme.dot, height: theme.dot)
    } else {
      Circle().fill(theme.inTool).frame(width: theme.dot, height: theme.dot)
    }
  }
}

// ◐: half filled, so idle reads differently from online in shape, not just colour.
struct HalfDot: View {
  var color: Color
  var body: some View {
    Circle().strokeBorder(color, lineWidth: 1)
      .overlay(Circle().fill(color).mask(HStack(spacing: 0) { Rectangle(); Color.clear }))
  }
}
