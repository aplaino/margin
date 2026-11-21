import AppKit

// An accessory app: no Dock icon, no menu bar; the drawer is its only window.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let model = AppModel()
  let drawer = DrawerController(model: model)
  withExtendedLifetime(drawer) { app.run() }
}
