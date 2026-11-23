import AppKit

// An accessory app: no Dock icon, no menu bar; the drawer is its only window.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let launcher = Launcher()
  launcher.start()
  // A plain kill is handled like Quit, so the bundled margind is stopped too.
  signal(SIGTERM, SIG_IGN)
  let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  terminate.setEventHandler { NSApp.terminate(nil) }
  terminate.resume()
  let model = AppModel()
  // Quitting (or relaunching for an update) first tells margind it isn't a hang.
  NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) {
    _ in
    MainActor.assumeIsolated {
      model.client.send(["op": "app.quitting"])
      launcher.stop()
    }
  }
  #if DEBUG
    // Debug builds: `kill -USR1 <pid>` blocks the main thread for 10 s, to test hang reports.
    signal(SIGUSR1, SIG_IGN)
    let freeze = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
    freeze.setEventHandler { Thread.sleep(forTimeInterval: 10) }
    freeze.resume()
  #else
    let freeze: DispatchSourceSignal? = nil
  #endif
  // Give whatever stopped (say, `bun run dev`) a moment to come back before starting our own.
  model.onDaemonLost = {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { MainActor.assumeIsolated { launcher.ensureRunning() } }
  }
  let drawer = DrawerController(model: model)
  #if DEBUG
    // Debug builds: `kill -USR2 <pid>` leaves the drawer's windows on this desktop only.
    signal(SIGUSR2, SIG_IGN)
    let strand = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
    strand.setEventHandler { MainActor.assumeIsolated { drawer.strandOnThisDesktop() } }
    strand.resume()
  #else
    let strand: DispatchSourceSignal? = nil
  #endif
  withExtendedLifetime((drawer, launcher, terminate, freeze, strand)) { app.run() }
}
