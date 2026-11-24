import SwiftUI

struct Peek: Equatable {
  var id: String
  var handle: String
  var name: String
  var preview: String?
  // A friend coming online rather than a message: their status, for the dot. `name` is the
  // whole line ("Maya is online"), and `handle` is empty when it names several.
  var online: String? = nil
}

// The tab that slides out beside the strip, or down from the menu bar, when a message arrives,
// or, quieter, when a friend comes online.
struct PeekView: View {
  var onOpen: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    if let peek = model.peek {
      Button(action: onOpen) {
        HStack(spacing: 8) {
          if let status = peek.online {
            PresenceDot(status: status, size: theme.rowDot)
            Text(verbatim: peek.name).font(theme.small).lineLimit(1).fixedSize()
          } else {
            Circle().fill(theme.unread).frame(width: 7, height: 7)
            Text(peek.name).font(theme.bodyBold).lineLimit(1).fixedSize()
          }
          if let preview = peek.preview, !preview.isEmpty {
            Text(preview).font(theme.small).foregroundStyle(theme.secondary).lineLimit(1)
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .foregroundStyle(theme.text)
        .themeSurface(shape, theme)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(peek.online == nil ? "New message from \(peek.name). Open chat." : "\(peek.name).")
    }
  }

  private var shape: UnevenRoundedRectangle {
    if model.atTop {
      let r = theme.controlRadius + 2
      return UnevenRoundedRectangle(topLeadingRadius: r, bottomLeadingRadius: r, bottomTrailingRadius: r, topTrailingRadius: r)
    }
    return model.prefs.edge == "left"
      ? UnevenRoundedRectangle(bottomTrailingRadius: theme.controlRadius + 2, topTrailingRadius: theme.controlRadius + 2)
      : UnevenRoundedRectangle(topLeadingRadius: theme.controlRadius + 2, bottomLeadingRadius: theme.controlRadius + 2)
  }
}
