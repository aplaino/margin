import SwiftUI

// The always-visible strip: a dot per online friend (● in a tool, ◐ idle), +N past 12, and
// the unread count. A new message pulses it three times. With nobody online and nothing
// unread it fades to a hairline at the screen edge, back to full while the pointer is on it.
struct StripView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var glow = false

  private let maxDots = 12

  var body: some View {
    let online = model.onlineFriends
    let connected = model.me?.connection == "online"
    // Only when hovering opens Margin: a faded strip is found by pointing at the edge, and
    // with hover off it has to be seen to be clicked.
    let quiet =
      model.prefs.fadeWhenQuiet && model.prefs.openOnHover && model.signedIn && online.isEmpty
      && model.unreadTotal == 0 && !model.stripHovered
    VStack(spacing: theme.stripSpacing) {
      if !model.signedIn {
        Circle().strokeBorder(theme.offline, lineWidth: 1).frame(width: theme.dot, height: theme.dot)
      } else {
        ForEach(online.prefix(maxDots)) { friend in
          dot(friend).opacity(connected ? 1 : 0.35)
        }
        if online.count > maxDots {
          Text("+\(online.count - maxDots)").font(theme.font(6.5, bold: true))
            .foregroundStyle(theme.secondary).fixedSize().frame(height: theme.stripLabel)
        }
        // Stays a filled badge until read.
        if model.unreadTotal > 0 {
          Text(model.unreadTotal > 9 ? "9+" : "\(model.unreadTotal)").font(theme.font(6.5, bold: true))
            .foregroundStyle(theme.onUnread).fixedSize()
            .frame(width: 8, height: theme.stripLabel)
            .background(Capsule().fill(theme.unread))
        }
      }
    }
    .padding(.vertical, theme.stripPadding)
    .frame(width: quiet ? 3 : theme.stripWidth)
    .frame(minHeight: 32)
    .themeSurface(shape, theme)
    .opacity(quiet ? 0.25 : 1)
    .frame(width: theme.stripWidth, alignment: model.prefs.edge == "left" ? .leading : .trailing)
    .animation(.easeOut(duration: 0.2), value: quiet)
    .shadow(color: theme.unread.opacity(glow ? 0.9 : 0), radius: glow ? 6 : 0)
    // Three pulses for a new message.
    .onChange(of: model.pulse) {
      for beat in 0..<3 {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(beat) * 0.5) {
          withAnimation(.easeOut(duration: 0.18)) { glow = true }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(beat) * 0.5 + 0.25) {
          withAnimation(.easeIn(duration: 0.2)) { glow = false }
        }
      }
    }
    .accessibilityElement()
    .accessibilityLabel("Margin: \(online.count) friends online, \(model.unreadTotal) unread")
    .accessibilityAddTraits(.isButton)
  }

  private var shape: UnevenRoundedRectangle {
    model.prefs.edge == "left"
      ? UnevenRoundedRectangle(bottomTrailingRadius: theme.stripRadius, topTrailingRadius: theme.stripRadius)
      : UnevenRoundedRectangle(topLeadingRadius: theme.stripRadius, bottomLeadingRadius: theme.stripRadius)
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
