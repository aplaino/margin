import AppKit

// Which desktops (Spaces) a window is on, and putting it back on the ones it lost. macOS has no
// public API for this, so it uses the window server's private calls, loaded with dlsym; if one
// is ever missing, windows are read as on no desktop and nothing is changed.
//
// Adding, moving or removing a desktop in Mission Control, or a full-screen desktop closing,
// can cut a window that's set to be on every desktop down to some of them (new windows aren't
// affected). Ordering it out and back in, or setting its collectionBehavior again, doesn't
// undo that; adding it to the desktops it's missing does, showing or not (docs/KNOWLEDGE.md).
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

  // Whether a display is showing a full-screen app (its current desktop has type 4), from the
  // window server's list of displays. With "Displays have separate Spaces" off there's one
  // entry, "Main", for every display.
  static func fullScreen(display: String, in list: [[String: Any]]) -> Bool {
    let id = { (entry: [String: Any]) in (entry["Display Identifier"] as? String)?.uppercased() }
    let entry = list.first { id($0) == display.uppercased() } ?? (list.count == 1 && id(list[0]) == "MAIN" ? list[0] : nil)
    return (entry?["Current Space"] as? [String: Any])?["type"] as? Int == 4
  }

  static func fullScreen(_ screen: NSScreen) -> Bool {
    guard let connection, let displaySpaces,
      let list = displaySpaces(connection)?.takeRetainedValue() as? [[String: Any]],
      let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
      let uuid = CGDisplayCreateUUIDFromDisplayID(number)?.takeRetainedValue(),
      let id = CFUUIDCreateString(nil, uuid) as String?
    else { return false }
    return fullScreen(display: id, in: list)
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
