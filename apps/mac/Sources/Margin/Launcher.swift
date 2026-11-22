import AppKit
import Foundation
import ServiceManagement

// Runs the margind that ships inside Margin.app, unless one is already running (as with
// `bun run dev`). Restarts it if it stops unexpectedly; quitting Margin stops it, which
// tells friends you've gone offline straight away.
@MainActor
final class Launcher {
  private var process: Process?
  private var stopping = false
  private var startedAt = Date.distantPast
  private var restarts = 0
  // Margin found someone else's margind at launch (`bun run dev`'s) and is using it.
  private var borrowed = false

  static var dataHome: String {
    ProcessInfo.processInfo.environment["MARGIN_HOME"]
      ?? (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Margin")
  }

  // Server and GitHub app this build talks to, set when it's built (see scripts/build-app.sh).
  static func setting(_ key: String) -> String? {
    let value = Bundle.main.object(forInfoDictionaryKey: key) as? String
    return value?.isEmpty == false ? value : nil
  }

  func start() {
    if DaemonClient.isRunning(path: DaemonClient.defaultPath()) {
      borrowed = true
      return
    }
    launch()
  }

  // Takes over once if the margind Margin borrowed went away (`bun run dev`'s, after Ctrl-C)
  // and nothing has taken its place. One Margin started itself is left to exited(), so a
  // crashing margind still stops after five tries.
  func ensureRunning() {
    guard borrowed, process == nil, !stopping, !DaemonClient.isRunning(path: DaemonClient.defaultPath()) else { return }
    borrowed = false
    launch()
  }

  private func launch() {
    guard !stopping, let url = Bundle.main.url(forAuxiliaryExecutable: "margind") else { return }
    try? FileManager.default.createDirectory(
      atPath: Launcher.dataHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let logPath = (Launcher.dataHome as NSString).appendingPathComponent("margind.log")
    if !FileManager.default.fileExists(atPath: logPath) {
      FileManager.default.createFile(atPath: logPath, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let log = FileHandle(forWritingAtPath: logPath)
    log?.seekToEndOfFile()

    let process = Process()
    process.executableURL = url
    var environment = ProcessInfo.processInfo.environment
    if let server = Launcher.setting("MarginServer") { environment["MARGIN_SERVER"] = server }
    if let clientId = Launcher.setting("MarginGitHubClientID") { environment["MARGIN_GITHUB_CLIENT_ID"] = clientId }
    // margind exits if Margin goes away without stopping it (a crash or a kill).
    environment["MARGIN_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
    process.environment = environment
    process.standardOutput = log
    process.standardError = log
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.exited() } }
    }
    do {
      try process.run()
      self.process = process
      startedAt = Date()
    } catch {
      self.process = nil
    }
  }

  private func exited() {
    process = nil
    guard !stopping else { return }
    // A run that lasted a while starts the count again; a crash loop gives up after five tries.
    if Date().timeIntervalSince(startedAt) > 60 { restarts = 0 }
    restarts += 1
    guard restarts <= 5 else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.launch() }
  }

  func stop() {
    stopping = true
    guard let process, process.isRunning else { return }
    process.terminate()
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  }

  // Margin opens at login once setup is done; Settings can turn it off.
  static var opensAtLogin: Bool { SMAppService.mainApp.status == .enabled }

  static func setOpensAtLogin(_ on: Bool) {
    if on { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
  }
}
