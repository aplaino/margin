import Foundation
import Observation

// How the drawer behaves on this Mac. Privacy settings live in margind; these don't need to.
@Observable @MainActor
final class Prefs {
  private let defaults = UserDefaults.standard

  var openOnHover: Bool { didSet { defaults.set(openOnHover, forKey: "openOnHover") } }
  var openOnClick: Bool { didSet { defaults.set(openOnClick, forKey: "openOnClick") } }
  var openOnHotkey: Bool { didSet { defaults.set(openOnHotkey, forKey: "openOnHotkey") } }
  // "right" or "left"
  var edge: String { didSet { defaults.set(edge, forKey: "edge") } }
  // In the menu bar beside the notch instead of on a screen edge.
  var menuBar: Bool { didSet { defaults.set(menuBar, forKey: "menuBar") } }
  // Where along the edge the strip sits, 0 (top) to 1 (bottom), set by dragging it.
  // nil until you move it: top if the Dock shares the edge, else the middle.
  var position: Double? {
    didSet {
      if let position { defaults.set(position, forKey: "position") } else { defaults.removeObject(forKey: "position") }
    }
  }
  var style: ThemeStyle { didSet { defaults.set(style.rawValue, forKey: "style") } }
  // Your changes for the Custom theme.
  var customTheme: CustomTheme {
    didSet { defaults.set(try? JSONEncoder().encode(customTheme), forKey: "customTheme") }
  }
  // "system", "light", "dark"
  var appearance: String { didSet { defaults.set(appearance, forKey: "appearance") } }
  var accent: Accent { didSet { defaults.set(accent.rawValue, forKey: "accent") } }
  // How new messages alert you: "margin" (Margin's own, beside the strip) or "macos" (macOS
  // notifications), never both.
  var alerts: String { didSet { defaults.set(alerts, forKey: "alerts") } }
  // What alerts show: "preview" (the name and first words), "name", or "glow" (strip only,
  // Margin's own alerts only).
  var alert: String { didSet { defaults.set(alert, forKey: "alert") } }
  // New messages arrive quietly until then: no pulse, no tab, no macOS notification. Margin's
  // own alerts aren't macOS notifications, so Focus doesn't silence them; this does.
  var alertsPausedUntil: Date? {
    didSet {
      if let alertsPausedUntil { defaults.set(alertsPausedUntil, forKey: "alertsPausedUntil") } else { defaults.removeObject(forKey: "alertsPausedUntil") }
    }
  }
  var alertsPaused: Bool { alertsPausedUntil.map { $0 > .now } ?? false }
  // Crash reports: "ask" after a crash, "always" send, or "never" send.
  var crashReports: String { didSet { defaults.set(crashReports, forKey: "crashReports") } }
  // When you last answered about waiting reports; errors are asked about at most once a day.
  var reportsAnsweredAt: Date? { didSet { defaults.set(reportsAnsweredAt, forKey: "reportsAnsweredAt") } }
  // Thin the strip to a faint hairline while nobody's online and nothing is unread.
  var fadeWhenQuiet: Bool { didSet { defaults.set(fadeWhenQuiet, forKey: "fadeWhenQuiet") } }
  // The unit your token total is shown in, or scientific notation instead.
  var tokenUnit: TokenUnit { didSet { defaults.set(tokenUnit.rawValue, forKey: "tokenUnit") } }
  var scientificTokens: Bool { didSet { defaults.set(scientificTokens, forKey: "scientificTokens") } }
  // The language Margin opens in, or nil to follow the Mac. It's the same per-app setting as
  // System Settings → Language & Region → Applications, so the two never disagree, and like
  // that one it applies the next time Margin opens.
  var language: String? {
    didSet {
      if let language { defaults.set([language], forKey: "AppleLanguages") } else { defaults.removeObject(forKey: "AppleLanguages") }
    }
  }
  // What it was when this copy opened, so Settings can offer to relaunch after a change.
  let launchLanguage: String?
  static let languages = ["en", "es", "zh-Hans", "ja", "el"]
  var setupDone: Bool { didSet { defaults.set(setupDone, forKey: "setupDone") } }
  // The first-launch welcome window has been seen.
  var welcomed: Bool { didSet { defaults.set(welcomed, forKey: "welcomed") } }

  init() {
    Prefs.migrate(defaults)
    defaults.register(defaults: [
      "openOnHover": true, "openOnClick": true, "openOnHotkey": true, "edge": "right", "menuBar": false,
      "style": ThemeStyle.graphite.rawValue, "appearance": "system", "accent": Accent.blue.rawValue, "alerts": "margin", "alert": "preview", "crashReports": "ask", "fadeWhenQuiet": true, "tokenUnit": TokenUnit.m.rawValue, "scientificTokens": false, "setupDone": false, "welcomed": false,
    ])
    openOnHover = defaults.bool(forKey: "openOnHover")
    openOnClick = defaults.bool(forKey: "openOnClick")
    openOnHotkey = defaults.bool(forKey: "openOnHotkey")
    edge = defaults.string(forKey: "edge") ?? "right"
    menuBar = defaults.bool(forKey: "menuBar")
    position = defaults.object(forKey: "position") as? Double
    style = ThemeStyle(rawValue: defaults.string(forKey: "style") ?? "") ?? .graphite
    customTheme =
      defaults.data(forKey: "customTheme").flatMap { try? JSONDecoder().decode(CustomTheme.self, from: $0) }
      ?? CustomTheme()
    appearance = defaults.string(forKey: "appearance") ?? "system"
    accent = Accent(rawValue: defaults.string(forKey: "accent") ?? "") ?? .blue
    alerts = defaults.string(forKey: "alerts") ?? "margin"
    alert = defaults.string(forKey: "alert") ?? "preview"
    alertsPausedUntil = defaults.object(forKey: "alertsPausedUntil") as? Date
    crashReports = defaults.string(forKey: "crashReports") ?? "ask"
    reportsAnsweredAt = defaults.object(forKey: "reportsAnsweredAt") as? Date
    fadeWhenQuiet = defaults.bool(forKey: "fadeWhenQuiet")
    tokenUnit = TokenUnit(rawValue: defaults.string(forKey: "tokenUnit") ?? "") ?? .m
    scientificTokens = defaults.bool(forKey: "scientificTokens")
    // Only Margin's own choice, not the Mac's languages; System Settings may store "es-ES" for "es".
    let chosen = (defaults.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "")?["AppleLanguages"] as? [String])?.first
    let language = chosen.flatMap { Bundle.preferredLocalizations(from: Prefs.languages, forPreferences: [$0]).first }
    self.language = language
    launchLanguage = language
    setupDone = defaults.bool(forKey: "setupDone")
    welcomed = defaults.bool(forKey: "welcomed")
  }

  // macOS notifications used to be a switch beside Margin's own alerts. Whoever turned it on
  // keeps them, showing the name only as before: no more leaves Margin than they agreed to.
  nonisolated static func migrate(_ defaults: UserDefaults) {
    guard defaults.object(forKey: "notifications") != nil else { return }
    if defaults.bool(forKey: "notifications") {
      defaults.set("macos", forKey: "alerts")
      defaults.set("name", forKey: "alert")
    }
    defaults.removeObject(forKey: "notifications")
  }

  // The theme to draw with: the chosen one, or the custom theme on top of its starting point.
  func theme(dark: Bool) -> Theme {
    guard style == .custom else { return style.theme(dark: dark || style.alwaysDark, accent: accent.color) }
    let base = customTheme.baseStyle
    return customTheme.apply(base.theme(dark: dark || base.alwaysDark, accent: accent.color))
  }

  func tokenTotal(_ value: Double?) -> String {
    Format.total(value, unit: tokenUnit, scientific: scientificTokens)
  }

  // Still the default (millions), so the header has room to say what the number is.
  var defaultTokenFormat: Bool { tokenUnit == .m && !scientificTokens }

  // Midnight, or a custom theme started from it, is always dark.
  var alwaysDark: Bool { style == .custom ? customTheme.baseStyle.alwaysDark : style.alwaysDark }

  static var dockEdge: String {
    UserDefaults(suiteName: "com.apple.dock")?.string(forKey: "orientation") ?? "bottom"
  }

  var resolvedPosition: Double { position ?? (Prefs.dockEdge == edge ? 0 : 0.5) }

  func resetPosition() {
    edge = "right"
    position = nil
  }
}
