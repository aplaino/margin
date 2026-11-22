import AppKit
import Foundation
import Security

// Moves a Margin that's running from Downloads (or anywhere else) into /Applications, where
// it can update itself and its tool hooks stay put, then relaunches it from there.
enum Mover {
  enum Failure: LocalizedError {
    case copy(String)
    var errorDescription: String? {
      switch self {
      case .copy(let reason): String(localized: "Couldn’t move Margin: \(reason). Drag it into Applications instead.")
      }
    }
  }

  static let destination = URL(fileURLWithPath: "/Applications/Margin.app")

  // Where the app really is when macOS runs a downloaded copy from a temporary location.
  static func original(of url: URL) -> URL {
    typealias Resolve = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
    guard url.path.contains("/AppTranslocation/"),
      let security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
      let symbol = dlsym(security, "SecTranslocateCreateOriginalPathForURL")
    else { return url }
    let resolve = unsafeBitCast(symbol, to: Resolve.self)
    return (resolve(url as CFURL, nil)?.takeRetainedValue() as URL?) ?? url
  }

  private static func signatureIntact(_ url: URL) -> Bool {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return false }
    return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode), nil) == errSecSuccess
  }

  @MainActor
  static func moveToApplications() throws {
    let running = Bundle.main.bundleURL
    let source = original(of: running)
    let files = FileManager.default
    // Only an intact Margin is copied, and only an older Margin is replaced.
    guard signatureIntact(running) else { throw Failure.copy("this copy of Margin looks damaged") }
    let existing = (try? destination.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink
    if existing == true { throw Failure.copy("/Applications/Margin.app is a link, not an app") }
    if files.fileExists(atPath: destination.path), Bundle(url: destination)?.bundleIdentifier != Bundle.main.bundleIdentifier {
      throw Failure.copy("something else is already called Margin in Applications")
    }
    do {
      // An older Margin already there goes to the Trash, so nothing is lost.
      if files.fileExists(atPath: destination.path) { try files.trashItem(at: destination, resultingItemURL: nil) }
      // The copy keeps macOS's quarantine flag, so Gatekeeper checks it like any download.
      try files.copyItem(at: running, to: destination)
    } catch {
      throw Failure.copy(error.localizedDescription)
    }
    // The download itself goes to the Trash (only from Downloads, never from anywhere else).
    let downloads = files.urls(for: .downloadsDirectory, in: .userDomainMask).first?.standardizedFileURL.path ?? "/nonexistent"
    if source.standardizedFileURL.path.hasPrefix(downloads + "/") {
      try? files.trashItem(at: source, resultingItemURL: nil)
    }
    // Reopen from Applications once this copy (and its margind) have quit.
    let relaunch = Process()
    relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
    relaunch.arguments = ["-c", "sleep 1.5; /usr/bin/open \"$0\"", destination.path]
    try? relaunch.run()
    NSApp.terminate(nil)
  }
}
