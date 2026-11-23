import AppKit

// Which desktops (Spaces) a window is on, and putting it back on the ones it lost. macOS has no
// public API for this, so it uses the window server's private calls, loaded with dlsym; if one
// is ever missing, windows are read as on no desktop and nothing is changed.
//
// Adding, moving or removing a desktop in Mission Control can cut a window that's set to be on
// every desktop down to some of them (new windows aren't affected), and ordering it out and
// back in doesn't undo that. Adding it to the desktops it's missing is the repair: on a window
// cut down with CGSRemoveWindowsFromSpaces it works, showing or not, where order out/in and
// setting collectionBehavior again don't (docs/KNOWLEDGE.md has what's been seen).
enum Desktops {
  // The desktops a window should be on and isn't: the rest of its display's, full-screen ones
  // included. A window on no desktop has never been shown, and joins them all when it is.
  static func missing(on window: [Int], displays: [[Int]]) -> [Int] {
    guard let display = displays.first(where: { $0.contains(where: window.contains) }) else { return [] }
    return display.filter { !window.contains($0) }
  }

  // "1/5": how many of its display's desktops a window is on, for the log ("-" if none yet).
  static func summary(on window: [Int], displays: [[Int]]) -> String {
    guard let display = displays.first(where: { $0.contains(where: window.contains) }) else { return "-" }
    return "\(display.count - missing(on: window, displays: displays).count)/\(display.count)"
  }

  private typealias MainConnection = @convention(c) () -> Int32
  private typealias SpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
  private typealias DisplaySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
  private typealias WindowsToSpaces = @convention(c) (Int32, CFArray, CFArray) -> Void
  private typealias ActiveSpace = @convention(c) (Int32) -> Int

  private static let coreGraphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY)
  private static func load<T>(_ name: String, as: T.Type) -> T? {
    dlsym(coreGraphics, name).map { unsafeBitCast($0, to: T.self) }
  }
  private static let connection = load("CGSMainConnectionID", as: MainConnection.self)?()
  private static let spacesForWindows = load("CGSCopySpacesForWindows", as: SpacesForWindows.self)
  private static let displaySpaces = load("CGSCopyManagedDisplaySpaces", as: DisplaySpaces.self)
  private static let addToSpaces = load("CGSAddWindowsToSpaces", as: WindowsToSpaces.self)

  // Every display's desktops, in Mission Control order.
  static func displays() -> [[Int]] {
    guard let connection, let displaySpaces,
      let list = displaySpaces(connection)?.takeRetainedValue() as? [[String: Any]]
    else { return [] }
    return list.map { display in
      (display["Spaces"] as? [[String: Any]] ?? []).compactMap { $0["ManagedSpaceID"] as? Int ?? $0["id64"] as? Int }
    }
  }

  // All of a window's desktops (mask 7: the current one, the others and full-screen ones).
  static func of(_ window: NSWindow) -> [Int] {
    guard let connection, let spacesForWindows else { return [] }
    return (spacesForWindows(connection, 7, [window.windowNumber] as CFArray)?.takeRetainedValue() as? [Int]) ?? []
  }

  static func add(_ window: NSWindow, to spaces: [Int]) {
    guard let connection, let addToSpaces, !spaces.isEmpty else { return }
    addToSpaces(connection, [window.windowNumber] as CFArray, spaces as CFArray)
  }

  #if DEBUG
    // Takes a window off every desktop but this one, as a Mission Control edit can.
    static func strand(_ window: NSWindow) {
      guard let connection,
        let remove = load("CGSRemoveWindowsFromSpaces", as: WindowsToSpaces.self),
        let active = load("CGSGetActiveSpace", as: ActiveSpace.self)?(connection)
      else { return }
      // A window that's never been shown is on no desktop; put it on this one first.
      add(window, to: [active])
      remove(connection, [window.windowNumber] as CFArray, displays().flatMap { $0 }.filter { $0 != active } as CFArray)
    }
  #endif
}
