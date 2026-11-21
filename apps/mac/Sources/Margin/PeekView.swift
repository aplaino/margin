import SwiftUI

struct Peek: Equatable {
  var id: String
  var handle: String
  var name: String
  var preview: String?
}

// The tab that slides out beside the strip when a message arrives.
struct PeekView: View {
  var onOpen: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    if let peek = model.peek {
      Button(action: onOpen) {
        HStack(spacing: 8) {
          Circle().fill(theme.unread).frame(width: 7, height: 7)
          Text(peek.name).font(theme.bodyBold).lineLimit(1).fixedSize()
          if let preview = peek.preview {
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
      .accessibilityLabel("New message from \(peek.name). Open chat.")
    }
  }

  private var shape: UnevenRoundedRectangle {
    model.prefs.edge == "left"
      ? UnevenRoundedRectangle(bottomTrailingRadius: theme.controlRadius + 2, topTrailingRadius: theme.controlRadius + 2)
      : UnevenRoundedRectangle(topLeadingRadius: theme.controlRadius + 2, bottomLeadingRadius: theme.controlRadius + 2)
  }
}
