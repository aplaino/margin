import AppKit
import SwiftUI

// The menu bar item: placing it, drawing its image and noticing when macOS hides it.
extension DrawerController {
  // MARK: the menu bar item

  func setMenuBar(_ on: Bool) {
    guard on != (statusItem != nil) else { return }
    if on {
      let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      // macOS remembers where you ⌘-drag it.
      item.autosaveName = "Margin"
      if let button = item.button {
        button.imagePosition = .imageOnly
        button.addTrackingArea(
          NSTrackingArea(
            rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: hoverTracker))
        let target = ActionTarget { [weak self] in self?.stripClicked() }
        button.target = target
        button.action = #selector(ActionTarget.fire)
        button.setAccessibilityLabel("Margin")
        clickTarget = target
      }
      statusItem = item
      drawMenuBar()
    } else if let item = statusItem {
      collapse()
      NSStatusBar.system.removeStatusItem(item)
      statusItem = nil
      hiddenTimer?.invalidate()
      model.menuBarHidden = false
    }
    resizeStrip()
  }

  // macOS tucks menu bar items that don't fit under the notch: after a moment there, Margin
  // shows the edge strip until there's room again. When the whole menu bar is hidden (a
  // full-screen app, or a menu bar set to hide), Margin hides with it and comes back with it.
  func menuBarVisibilityChanged() {
    let crowdedOut = menuBarItemCrowdedOut
    hiddenTimer?.invalidate()
    if !crowdedOut {
      guard model.menuBarHidden else { return }
      model.menuBarHidden = false
      place(movingDrawer: true)
    } else {
      hiddenTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.statusItem != nil else { return }
          self.model.menuBarHidden = true
          self.place(movingDrawer: true)
        }
      }
    }
  }

  // Under the notch, or given no place in the menu bar at all. Being out of sight with the
  // rest of the menu bar doesn't count.
  var menuBarItemCrowdedOut: Bool {
    guard let window = statusItem?.button?.window else { return true }
    guard let screen = window.screen, let left = screen.auxiliaryTopLeftArea,
      let right = screen.auxiliaryTopRightArea
    else { return false }
    let notch = (screen.frame.minX + left.width)...(screen.frame.maxX - right.width)
    return notch.contains(window.frame.midX)
  }

  var inMenuBar: Bool { statusItem != nil && !model.menuBarHidden }

  // Draws the item again whenever what it shows changes: friends and their status, unread,
  // sign-in, connection, theme.
  func observeMenuBar() {
    withObservationTracking {
      _ = (
        model.onlineFriends.map(\.presence.status), model.unreadTotal, model.signedIn, model.me?.connection,
        model.prefs.style, model.prefs.accent, model.prefs.customTheme
      )
    } onChange: { [weak self] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.drawMenuBar()
          self?.observeMenuBar()
        }
      }
    }
  }

  // Each observer re-registers only itself: one that renewed the other too stacked
  // duplicates on every change, which multiplied until a message set off thousands of
  // redraws and pinned the CPU.
  func observePulse() {
    withObservationTracking {
      _ = model.pulse
    } onChange: { [weak self] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.pulseMenuBar()
          self?.observePulse()
        }
      }
    }
  }

  // The image follows the menu bar's own light or dark look, which depends on the wallpaper,
  // not on Margin's appearance setting. macOS sizes the item to the image.
  func drawMenuBar(glow: Double = 0) {
    guard let button = statusItem?.button else { return }
    let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    let look = MenuBarLook(
      signedIn: model.signedIn, connected: model.me?.connection == "online",
      statuses: model.onlineFriends.prefix(MenuBarView.maxDots).map(\.presence.status),
      online: model.onlineFriends.count, unread: model.unreadTotal, style: model.prefs.style.rawValue,
      accent: model.prefs.accent.rawValue, custom: model.prefs.customTheme, dark: dark, glow: glow,
      scale: button.window?.backingScaleFactor ?? 0)
    guard look != lastMenuBarLook else { return }
    lastMenuBarLook = look
    let renderer = ImageRenderer(
      content: Themed(model: model) { MenuBarView(glow: glow) }.environment(\.colorScheme, dark ? .dark : .light))
    renderer.scale = button.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
    guard let image = renderer.nsImage else { return }
    image.isTemplate = false
    button.image = image
    // A wider item can push it (or others) under the notch.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.menuBarVisibilityChanged() }
  }

  // Three pulses for a new message, like the strip: the glow rises and falls over half a
  // second each, drawn at 30 frames a second.
  func pulseMenuBar() {
    guard statusItem != nil else { return }
    let frames = reduceMotion ? 0 : 45
    for frame in 0...frames {
      let t = Double(frame) / 30
      let glow = frame == frames ? 0 : sin(.pi * (t.truncatingRemainder(dividingBy: 0.5) / 0.5))
      DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.drawMenuBar(glow: glow) }
    }
  }
  var menuBarAnchor: NSRect? { inMenuBar ? statusItem?.button?.window?.frame : nil }
}

// Everything the menu bar image is drawn from (MenuBarView): the same values draw the same image.
struct MenuBarLook: Equatable {
  var signedIn: Bool
  var connected: Bool
  var statuses: [String]
  var online: Int
  var unread: Int
  var style: String
  var accent: String
  var custom: CustomTheme
  var dark: Bool
  var glow: Double
  var scale: CGFloat
}
