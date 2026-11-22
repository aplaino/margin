import AppKit

// An accessory app: no Dock icon, no menu bar; the drawer is its only window.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let launcher = Launcher()
  launcher.start()
  NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) {
    _ in MainActor.assumeIsolated { launcher.stop() }
  }
  // A plain kill is handled like Quit, so the bundled margind is stopped too.
  signal(SIGTERM, SIG_IGN)
  let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  terminate.setEventHandler { NSApp.terminate(nil) }
  terminate.resume()
  let model = AppModel()
  // Give whatever stopped (say, `bun run dev`) a moment to come back before starting our own.
  model.onDaemonLost = {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { MainActor.assumeIsolated { launcher.ensureRunning() } }
  }
  let drawer = DrawerController(model: model)
  withExtendedLifetime((drawer, launcher, terminate)) { app.run() }
}
