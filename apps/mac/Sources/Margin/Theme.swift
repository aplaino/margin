import AppKit
import SwiftUI

// Every colour, font, shape and material the drawer uses comes from a Theme. The five
// built-in themes below are just values of it, each with a light and a dark version.
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
  var onAccent: Color = .white
  var inTool: Color
  var idle: Color
  var offline: Color
  var unread: Color
  var onUnread: Color
  var danger: Color

  // Frosted glass behind the panel and strip; `background` then tints it.
  var glass: NSVisualEffectView.Material?

  // Body text, and headings and names.
  var design: Font.Design = .default
  var headingDesign: Font.Design = .default
  var weight: Font.Weight = .regular
  var strong: Font.Weight = .semibold

  var radius: CGFloat = 12
  var rowRadius: CGFloat = 7
  var controlRadius: CGFloat = 8
  var bubbleRadius: CGFloat = 13
  var stripRadius: CGFloat = 5
  var borderWidth: CGFloat = 1

  var panelWidth: CGFloat = 260
  var stripWidth: CGFloat = 8
  var dot: CGFloat = 5
  // The strip: space between dots, padding at each end, and the height of its +N and unread labels.
  var stripSpacing: CGFloat = 7
  var stripPadding: CGFloat = 8
  var stripLabel: CGFloat = 9

  func font(_ size: CGFloat, bold: Bool = false, heading: Bool = false) -> Font {
    .system(size: size, weight: bold ? strong : weight, design: heading ? headingDesign : design)
  }
  var body: Font { font(13) }
  var bodyBold: Font { font(13, bold: true, heading: true) }
  var small: Font { font(11.5) }
  var caption: Font { font(11) }
  var mono: Font { .system(size: 11, weight: weight, design: .monospaced) }
  var section: Font { font(10, bold: true) }
  var title: Font { font(16, bold: true, heading: true) }
}

enum ThemeStyle: String, CaseIterable, Identifiable {
  case graphite, glass, paper, terminal, contrast
  var id: String { rawValue }

  var name: String {
    switch self {
    case .graphite: "Graphite"
    case .glass: "Glass"
    case .paper: "Paper"
    case .terminal: "Terminal"
    case .contrast: "High Contrast"
    }
  }

  func theme(dark: Bool, accent: Color) -> Theme {
    let rgb = { (r: Double, g: Double, b: Double) in Color(red: r / 255, green: g / 255, blue: b / 255) }
    switch (self, dark) {
    case (.graphite, true):
      return Theme(
        background: rgb(28, 28, 30).opacity(0.92), surface: .white.opacity(0.09), hover: .white.opacity(0.07),
        text: rgb(245, 245, 247), secondary: rgb(161, 161, 166), tertiary: rgb(142, 142, 147),
        divider: .white.opacity(0.08), border: .white.opacity(0.12), accent: accent,
        inTool: rgb(48, 209, 88), idle: rgb(255, 214, 10), offline: rgb(142, 142, 147),
        unread: rgb(255, 214, 10), onUnread: rgb(28, 28, 30), danger: rgb(255, 105, 97))
    case (.graphite, false):
      return Theme(
        background: rgb(246, 246, 248).opacity(0.95), surface: .black.opacity(0.06), hover: .black.opacity(0.05),
        text: rgb(29, 29, 31), secondary: rgb(99, 99, 104), tertiary: rgb(110, 110, 115),
        divider: .black.opacity(0.08), border: .black.opacity(0.12), accent: accent,
        inTool: rgb(36, 138, 61), idle: rgb(178, 120, 0), offline: rgb(110, 110, 115),
        unread: rgb(178, 120, 0), onUnread: .white, danger: rgb(215, 0, 21))

    case (.glass, true):
      return Theme(
        background: .black.opacity(0.22), surface: .white.opacity(0.12), hover: .white.opacity(0.10),
        text: .white, secondary: .white.opacity(0.75), tertiary: .white.opacity(0.62),
        divider: .white.opacity(0.14), border: .white.opacity(0.22), accent: accent,
        inTool: rgb(48, 209, 88), idle: rgb(255, 214, 10), offline: .white.opacity(0.6),
        unread: rgb(255, 214, 10), onUnread: rgb(28, 28, 30), danger: rgb(255, 120, 112),
        glass: .hudWindow, radius: 14, rowRadius: 8, controlRadius: 9, stripRadius: 6)
    case (.glass, false):
      return Theme(
        background: .white.opacity(0.32), surface: .black.opacity(0.07), hover: .black.opacity(0.06),
        text: .black.opacity(0.88), secondary: .black.opacity(0.64), tertiary: .black.opacity(0.58),
        divider: .black.opacity(0.10), border: .black.opacity(0.14), accent: accent,
        inTool: rgb(36, 138, 61), idle: rgb(170, 112, 0), offline: .black.opacity(0.55),
        unread: rgb(170, 112, 0), onUnread: .white, danger: rgb(200, 0, 20),
        glass: .popover, radius: 14, rowRadius: 8, controlRadius: 9, stripRadius: 6)

    case (.paper, true):
      return Theme(
        background: rgb(35, 32, 28).opacity(0.97), surface: .white.opacity(0.07), hover: .white.opacity(0.06),
        text: rgb(237, 230, 218), secondary: rgb(181, 172, 158), tertiary: rgb(160, 151, 137),
        divider: .white.opacity(0.08), border: .white.opacity(0.12), accent: accent,
        inTool: rgb(108, 192, 126), idle: rgb(224, 178, 82), offline: rgb(160, 151, 137),
        unread: rgb(224, 178, 82), onUnread: rgb(35, 32, 28), danger: rgb(240, 128, 112),
        headingDesign: .serif, radius: 10, rowRadius: 6)
    case (.paper, false):
      return Theme(
        background: rgb(247, 243, 234).opacity(0.98), surface: .black.opacity(0.05), hover: .black.opacity(0.04),
        text: rgb(43, 39, 34), secondary: rgb(102, 94, 84), tertiary: rgb(117, 108, 96),
        divider: .black.opacity(0.08), border: rgb(217, 208, 191), accent: accent,
        inTool: rgb(52, 125, 68), idle: rgb(150, 100, 20), offline: rgb(117, 108, 96),
        unread: rgb(150, 100, 20), onUnread: .white, danger: rgb(179, 38, 30),
        headingDesign: .serif, radius: 10, rowRadius: 6)

    case (.terminal, true):
      return Theme(
        background: rgb(12, 14, 16).opacity(0.97), surface: .white.opacity(0.06), hover: .white.opacity(0.06),
        text: rgb(215, 221, 226), secondary: rgb(142, 154, 164), tertiary: rgb(120, 133, 143),
        divider: .white.opacity(0.08), border: .white.opacity(0.14), accent: accent,
        inTool: rgb(74, 222, 128), idle: rgb(251, 191, 36), offline: rgb(120, 133, 143),
        unread: rgb(251, 191, 36), onUnread: .black, danger: rgb(248, 113, 113),
        design: .monospaced, headingDesign: .monospaced,
        radius: 3, rowRadius: 2, controlRadius: 2, bubbleRadius: 3, stripRadius: 1)
    case (.terminal, false):
      return Theme(
        background: rgb(250, 250, 247).opacity(0.98), surface: .black.opacity(0.05), hover: .black.opacity(0.05),
        text: rgb(31, 35, 40), secondary: rgb(87, 96, 106), tertiary: rgb(102, 112, 122),
        divider: .black.opacity(0.08), border: .black.opacity(0.14), accent: accent,
        inTool: rgb(26, 127, 55), idle: rgb(154, 103, 0), offline: rgb(102, 112, 122),
        unread: rgb(154, 103, 0), onUnread: .white, danger: rgb(207, 34, 46),
        design: .monospaced, headingDesign: .monospaced,
        radius: 3, rowRadius: 2, controlRadius: 2, bubbleRadius: 3, stripRadius: 1)

    case (.contrast, true):
      return Theme(
        background: .black, surface: .white.opacity(0.14), hover: .white.opacity(0.14),
        text: .white, secondary: rgb(230, 230, 230), tertiary: rgb(205, 205, 205),
        divider: .white.opacity(0.4), border: .white.opacity(0.7), accent: accent,
        inTool: rgb(52, 224, 90), idle: rgb(255, 214, 10), offline: rgb(205, 205, 205),
        unread: rgb(255, 214, 10), onUnread: .black, danger: rgb(255, 120, 120),
        weight: .medium, strong: .bold, borderWidth: 1.5)
    case (.contrast, false):
      return Theme(
        background: .white, surface: .black.opacity(0.08), hover: .black.opacity(0.08),
        text: .black, secondary: rgb(40, 40, 40), tertiary: rgb(64, 64, 64),
        divider: .black.opacity(0.4), border: .black.opacity(0.7), accent: accent,
        inTool: rgb(0, 110, 36), idle: rgb(125, 80, 0), offline: rgb(64, 64, 64),
        unread: rgb(125, 80, 0), onUnread: .white, danger: rgb(176, 0, 32),
        weight: .medium, strong: .bold, borderWidth: 1.5)
    }
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
  static let defaultValue = ThemeStyle.graphite.theme(dark: true, accent: Accent.blue.color)
}

extension EnvironmentValues {
  var theme: Theme {
    get { self[ThemeKey.self] }
    set { self[ThemeKey.self] = newValue }
  }
}

// Frosted glass that blurs whatever is behind the window.
struct VisualEffect: NSViewRepresentable {
  var material: NSVisualEffectView.Material

  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.blendingMode = .behindWindow
    view.state = .active
    view.material = material
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {
    view.material = material
  }
}

extension View {
  // The theme's panel surface in a shape: glass with a tint, or a solid fill, plus the border.
  func themeSurface<S: InsettableShape>(_ shape: S, _ theme: Theme) -> some View {
    background {
      ZStack {
        if let glass = theme.glass { VisualEffect(material: glass) }
        theme.background
      }
      .clipShape(shape)
    }
    .overlay(shape.strokeBorder(theme.border, lineWidth: theme.borderWidth))
  }
}
