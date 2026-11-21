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
  // "auto" (top if the Dock shares the edge, else centre), "top", "centre", "bottom"
  var height: String { didSet { defaults.set(height, forKey: "height") } }
  // "system", "light", "dark"
  var theme: String { didSet { defaults.set(theme, forKey: "theme") } }
  var accent: Accent { didSet { defaults.set(accent.rawValue, forKey: "accent") } }
  var notifications: Bool { didSet { defaults.set(notifications, forKey: "notifications") } }
  var setupDone: Bool { didSet { defaults.set(setupDone, forKey: "setupDone") } }

  init() {
    defaults.register(defaults: [
      "openOnHover": true, "openOnClick": true, "openOnHotkey": true, "edge": "right", "height": "auto",
      "theme": "system", "accent": Accent.blue.rawValue, "notifications": false, "setupDone": false,
    ])
    openOnHover = defaults.bool(forKey: "openOnHover")
    openOnClick = defaults.bool(forKey: "openOnClick")
    openOnHotkey = defaults.bool(forKey: "openOnHotkey")
    edge = defaults.string(forKey: "edge") ?? "right"
    height = defaults.string(forKey: "height") ?? "auto"
    theme = defaults.string(forKey: "theme") ?? "system"
    accent = Accent(rawValue: defaults.string(forKey: "accent") ?? "") ?? .blue
    notifications = defaults.bool(forKey: "notifications")
    setupDone = defaults.bool(forKey: "setupDone")
  }

  static var dockEdge: String {
    UserDefaults(suiteName: "com.apple.dock")?.string(forKey: "orientation") ?? "bottom"
  }

  var resolvedHeight: String {
    guard height == "auto" else { return height }
    return Prefs.dockEdge == edge ? "top" : "centre"
  }
}
