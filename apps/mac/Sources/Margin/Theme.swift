import SwiftUI

// Every colour, font and size the drawer uses comes from here, so a future theme is a
// different value of this struct, not edits across views.
struct Theme {
  var background: Color
  var surface: Color
  var hover: Color
  var text: Color
  var secondary: Color
  var tertiary: Color
  var divider: Color
  var border: Color
  var accent: Color
  var onAccent: Color
  var inTool: Color
  var idle: Color
  var offline: Color
  var unread: Color
  var onUnread: Color
  var danger: Color

  var body: Font = .system(size: 13)
  var bodyBold: Font = .system(size: 13, weight: .semibold)
  var small: Font = .system(size: 11.5)
  var caption: Font = .system(size: 11)
  var mono: Font = .system(size: 11, design: .monospaced)
  var section: Font = .system(size: 10, weight: .semibold)
  var title: Font = .system(size: 16, weight: .semibold)

  var panelWidth: CGFloat = 260
  var stripWidth: CGFloat = 8
  var radius: CGFloat = 12
  var rowRadius: CGFloat = 7
  var dot: CGFloat = 5

  // Presence colours never follow the accent, so the strip always reads the same.
  static func make(dark: Bool, accent: Color) -> Theme {
    if dark {
      return Theme(
        background: Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255).opacity(0.92),
        surface: Color.white.opacity(0.09),
        hover: Color.white.opacity(0.07),
        text: Color(red: 245 / 255, green: 245 / 255, blue: 247 / 255),
        secondary: Color(red: 161 / 255, green: 161 / 255, blue: 166 / 255),
        tertiary: Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255),
        divider: Color.white.opacity(0.08),
        border: Color.white.opacity(0.12),
        accent: accent,
        onAccent: .white,
        inTool: Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255),
        idle: Color(red: 1, green: 214 / 255, blue: 10 / 255),
        offline: Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255),
        unread: Color(red: 1, green: 214 / 255, blue: 10 / 255),
        onUnread: Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255),
        danger: Color(red: 1, green: 105 / 255, blue: 97 / 255)
      )
    }
    return Theme(
      background: Color(red: 246 / 255, green: 246 / 255, blue: 248 / 255).opacity(0.95),
      surface: Color.black.opacity(0.06),
      hover: Color.black.opacity(0.05),
      text: Color(red: 29 / 255, green: 29 / 255, blue: 31 / 255),
      secondary: Color(red: 99 / 255, green: 99 / 255, blue: 104 / 255),
      tertiary: Color(red: 110 / 255, green: 110 / 255, blue: 115 / 255),
      divider: Color.black.opacity(0.08),
      border: Color.black.opacity(0.12),
      accent: accent,
      onAccent: .white,
      inTool: Color(red: 36 / 255, green: 138 / 255, blue: 61 / 255),
      idle: Color(red: 178 / 255, green: 120 / 255, blue: 0),
      offline: Color(red: 110 / 255, green: 110 / 255, blue: 115 / 255),
      unread: Color(red: 178 / 255, green: 120 / 255, blue: 0),
      onUnread: .white,
      danger: Color(red: 215 / 255, green: 0, blue: 21 / 255)
    )
  }
}

enum Accent: String, CaseIterable, Identifiable {
  case blue, green, orange, purple, graphite
  var id: String { rawValue }
  var color: Color {
    switch self {
    case .blue: Color(red: 10 / 255, green: 132 / 255, blue: 1)
    case .green: Color(red: 40 / 255, green: 160 / 255, blue: 70 / 255)
    case .orange: Color(red: 1, green: 149 / 255, blue: 0)
    case .purple: Color(red: 175 / 255, green: 82 / 255, blue: 222 / 255)
    case .graphite: Color(red: 128 / 255, green: 128 / 255, blue: 133 / 255)
    }
  }
}

private struct ThemeKey: EnvironmentKey {
  static let defaultValue = Theme.make(dark: true, accent: Accent.blue.color)
}

extension EnvironmentValues {
  var theme: Theme {
    get { self[ThemeKey.self] }
    set { self[ThemeKey.self] = newValue }
  }
}
