import AppKit
import SwiftUI

// The one custom theme: a built-in theme to start from, and whatever you changed on top of it.
// Anything left unset comes from the starting theme, in its light or dark version.
struct CustomTheme: Codable, Equatable {
  var base: String = ThemeStyle.graphite.rawValue
  // Colours, as RRGGBB.
  var background: String?
  var surface: String?
  var text: String?
  var border: String?
  var accent: String?
  var inTool: String?
  var idle: String?
  var unread: String?
  // "system", "rounded", "serif", "monospaced", or an installed font family.
  var typeface: String?
  // "light", "regular" or "medium".
  var weight: String?
  var textScale: Double?
  // 0 square to 1 round.
  var roundness: Double?
  var glass: Bool?
  var dotShape: DotShape?
  var dotScale: Double?

  var baseStyle: ThemeStyle {
    guard let style = ThemeStyle(rawValue: base), style != .custom else { return .graphite }
    return style
  }

  func apply(_ start: Theme) -> Theme {
    var t = start
    if let glass { t.glass = glass ? (start.glass ?? .hudWindow) : nil }
    if let c = Color(hex: background) { t.background = c.opacity(t.glass == nil ? 0.97 : 0.55) }
    if let c = Color(hex: surface) { t.surface = c }
    if let c = Color(hex: text) {
      t.text = c
      t.secondary = c.opacity(0.7)
      t.tertiary = c.opacity(0.56)
      t.offline = c.opacity(0.56)
      t.divider = c.opacity(0.1)
      t.hover = c.opacity(0.07)
    }
    if let c = Color(hex: border) { t.border = c }
    if let c = Color(hex: accent) {
      t.accent = c
      t.onAccent = c.readableText
    }
    if let c = Color(hex: inTool) { t.inTool = c }
    if let c = Color(hex: idle) { t.idle = c }
    if let c = Color(hex: unread) {
      t.unread = c
      t.onUnread = c.readableText
    }
    switch typeface {
    case nil: break
    case "system": (t.design, t.headingDesign, t.fontName) = (.default, .default, nil)
    case "rounded": (t.design, t.headingDesign, t.fontName) = (.rounded, .rounded, nil)
    case "serif": (t.design, t.headingDesign, t.fontName) = (.serif, .serif, nil)
    case "monospaced": (t.design, t.headingDesign, t.fontName) = (.monospaced, .monospaced, nil)
    case let family?: t.fontName = family
    }
    switch weight {
    case "light": (t.weight, t.strong) = (.light, .medium)
    case "regular": (t.weight, t.strong) = (.regular, .semibold)
    case "medium": (t.weight, t.strong) = (.medium, .bold)
    default: break
    }
    if let textScale { t.textScale = CGFloat(textScale) }
    if let roundness {
      let r = CGFloat(roundness)
      t.radius = 2 + 20 * r
      t.rowRadius = 1 + 11 * r
      t.controlRadius = 1 + 13 * r
      t.bubbleRadius = 2 + 16 * r
      t.stripRadius = 1 + 6 * r
    }
    if let dotShape { t.dotShape = dotShape }
    if let dotScale {
      t.dot *= CGFloat(dotScale)
      t.rowDot *= CGFloat(dotScale)
    }
    return t
  }
}

extension Color {
  init?(hex: String?) {
    guard let hex, hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
    self.init(
      red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255)
  }

  // RRGGBB in sRGB, ignoring opacity.
  var hex: String {
    let c = NSColor(self).usingColorSpace(.sRGB) ?? .black
    let v = [c.redComponent, c.greenComponent, c.blueComponent].map { Int(($0 * 255).rounded()) }
    return String(format: "%02X%02X%02X", v[0], v[1], v[2])
  }

  // Black or white, whichever reads on this colour.
  var readableText: Color {
    let c = NSColor(self).usingColorSpace(.sRGB) ?? .black
    let luminance = 0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent
    return luminance > 0.6 ? .black : .white
  }
}
