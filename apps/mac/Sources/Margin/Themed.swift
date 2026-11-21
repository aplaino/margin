import SwiftUI

// Gives every view the theme for the current appearance and accent.
struct Themed<Content: View>: View {
  let model: AppModel
  @ViewBuilder var content: () -> Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    content()
      .environment(model)
      .environment(\.theme, model.prefs.style.theme(dark: scheme == .dark, accent: model.prefs.accent.color))
  }
}
