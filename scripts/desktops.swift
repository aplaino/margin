// Read-only: which desktops (Spaces) each of Margin's windows is on, against every desktop
// there is (`swift scripts/desktops.swift`, or pass another app's name). Uses private
// CoreGraphics calls loaded with dlsym; changes nothing.
import CoreGraphics
import Foundation

typealias MainConnection = @convention(c) () -> Int32
typealias SpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
typealias DisplaySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?

let cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)
func load<T>(_ name: String, as: T.Type) -> T { unsafeBitCast(dlsym(cg, name)!, to: T.self) }
let connection = load("CGSMainConnectionID", as: MainConnection.self)()
let spacesFor = load("CGSCopySpacesForWindows", as: SpacesForWindows.self)
let displaySpaces = load("CGSCopyManagedDisplaySpaces", as: DisplaySpaces.self)

// Every desktop, in Mission Control order, per display.
var all: [Int] = []
if let displays = displaySpaces(connection)?.takeRetainedValue() as? [[String: Any]] {
  for display in displays {
    for space in display["Spaces"] as? [[String: Any]] ?? [] {
      if let id = space["ManagedSpaceID"] as? Int ?? space["id64"] as? Int { all.append(id) }
    }
  }
}
print("all desktops: \(all)")

let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows where (window[kCGWindowOwnerName as String] as? String) == (CommandLine.arguments.dropFirst().first ?? "Margin") {
  guard let number = window[kCGWindowNumber as String] as? Int else { continue }
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  let on = window[kCGWindowIsOnscreen as String] as? Bool ?? false
  let spaces = (spacesFor(connection, 7, [number] as CFArray)?.takeRetainedValue() as? [Int]) ?? []
  let missing = all.filter { !spaces.contains($0) }
  print(
    "window \(number) layer \(layer) \(on ? "on" : "off") \(Int(bounds["Width"] as? Double ?? 0))x\(Int(bounds["Height"] as? Double ?? 0)): spaces \(spaces.sorted())"
      + (spaces.isEmpty ? "" : missing.isEmpty ? "  ALL" : "  missing \(missing)"))
}
