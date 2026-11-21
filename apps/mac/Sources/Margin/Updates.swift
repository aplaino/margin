import Foundation
import Sparkle

// Automatic updates from the Margin server's feed, verified with Margin's EdDSA key.
// Margin rarely quits, so instead of waiting for a quit, a downloaded update installs
// straight away (relaunching Margin) whenever the drawer is closed.
@MainActor
final class Updates: NSObject, SPUUpdaterDelegate {
  private var controller: SPUStandardUpdaterController?
  private var pendingInstall: (() -> Void)?
  weak var model: AppModel?

  // Only builds with a feed (release builds) update; development builds don't.
  var enabled: Bool { controller != nil }

  override init() {
    super.init()
    guard Launcher.setting("SUFeedURL") != nil else { return }
    controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    // Catch up at launch rather than waiting for the hourly check.
    controller?.updater.checkForUpdatesInBackground()
  }

  func checkNow() {
    controller?.checkForUpdates(nil)
  }

  func checkInBackground() {
    controller?.updater.checkForUpdatesInBackground()
  }

  // Called when the drawer closes, to install an update that arrived while it was open.
  func drawerClosed() {
    let install = pendingInstall
    pendingInstall = nil
    install?()
  }

  nonisolated func updater(
    _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
  ) -> Bool {
    MainActor.assumeIsolated {
      if model?.expanded == true {
        pendingInstall = immediateInstallHandler
      } else {
        immediateInstallHandler()
      }
    }
    return true
  }
}
