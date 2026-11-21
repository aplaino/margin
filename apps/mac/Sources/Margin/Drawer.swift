import AppKit
import Carbon.HIToolbox
import SwiftUI

// A borderless panel that never activates Margin on its own; it becomes key only when a
// text field needs the keyboard, or when opened with the hotkey.
final class DrawerPanel: NSPanel {
  var onEscape: (() -> Void)?

  init(content: NSView) {
    super.init(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    backgroundColor = .clear
    isOpaque = false
    hasShadow = false
    hidesOnDeactivate = false
    becomesKeyOnlyIfNeeded = true
    isMovable = false
    contentView = content
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  override func cancelOperation(_ sender: Any?) { onEscape?() }
}

// Hosts SwiftUI and reports the pointer entering and leaving, even when Margin isn't active.
final class TrackingHostingView<Content: View>: NSHostingView<Content> {
  var onHover: ((Bool) -> Void)?
  private var area: NSTrackingArea?

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let area { removeTrackingArea(area) }
    let next = NSTrackingArea(
      rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(next)
    area = next
  }

  override func mouseEntered(with event: NSEvent) { onHover?(true) }
  override func mouseExited(with event: NSEvent) { onHover?(false) }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// ⌥M from anywhere. Carbon hotkeys need no Accessibility permission.
final class HotKey {
  nonisolated(unsafe) private static var action: (() -> Void)?
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?

  init(action: @escaping () -> Void) {
    HotKey.action = action
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, _ in
        DispatchQueue.main.async { HotKey.action?() }
        return noErr
      }, 1, &spec, nil, &handler)
  }

  func set(enabled: Bool) {
    if let ref {
      UnregisterEventHotKey(ref)
      self.ref = nil
    }
    guard enabled else { return }
    let id = EventHotKeyID(signature: OSType(0x4D52_474E), id: 1)
    RegisterEventHotKey(UInt32(kVK_ANSI_M), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &ref)
  }
}

@MainActor
final class DrawerController {
  private let model: AppModel
  private let strip: DrawerPanel
  private let panel: DrawerPanel
  private let stripView: TrackingHostingView<AnyView>
  private let panelView: TrackingHostingView<AnyView>
  private var stripSize = CGSize(width: 8, height: 32)
  private var openTimer: Timer?
  private var closeTimer: Timer?
  private var openedByHover = false
  private var previousApp: NSRunningApplication?
  private var clickMonitor: Any?
  private var hotKey: HotKey?

  private let edgeMargin: CGFloat = 80
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  init(model: AppModel) {
    self.model = model
    stripView = TrackingHostingView(rootView: AnyView(EmptyView()))
    panelView = TrackingHostingView(rootView: AnyView(EmptyView()))
    strip = DrawerPanel(content: stripView)
    panel = DrawerPanel(content: panelView)

    let onSize: (CGSize) -> Void = { [weak self] size in self?.stripResized(size) }
    let onTap: () -> Void = { [weak self] in self?.stripClicked() }
    let onClose: () -> Void = { [weak self] in self?.collapse() }
    stripView.rootView = AnyView(Themed(model: model) { StripView(onSize: onSize, onTap: onTap) })
    panelView.rootView = AnyView(Themed(model: model) { PanelView(onClose: onClose) })

    stripView.onHover = { [weak self] inside in self?.stripHover(inside) }
    panelView.onHover = { [weak self] inside in self?.panelHover(inside) }
    panel.onEscape = { [weak self] in self?.escape() }

    hotKey = HotKey { [weak self] in self?.hotKeyPressed() }
    observePrefs()

    let center = NotificationCenter.default
    center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.place() }
    }
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.place() } }

    place()
    strip.orderFrontRegardless()
  }

  // Re-applies settings that affect the windows whenever they change.
  private func observePrefs() {
    withObservationTracking {
      _ = (model.prefs.theme, model.prefs.edge, model.prefs.height, model.prefs.openOnHotkey)
    } onChange: { [weak self] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.applyPrefs()
          self?.observePrefs()
        }
      }
    }
    applyPrefs()
  }

  private func applyPrefs() {
    let appearance: NSAppearance? =
      switch model.prefs.theme {
      case "light": NSAppearance(named: .aqua)
      case "dark": NSAppearance(named: .darkAqua)
      default: nil
      }
    strip.appearance = appearance
    panel.appearance = appearance
    hotKey?.set(enabled: model.prefs.openOnHotkey)
    place()
  }

  // The screen you're working on: the one with the frontmost window.
  private var screen: NSScreen? { NSScreen.main ?? NSScreen.screens.first }

  private func stripFrame(on screen: NSScreen) -> NSRect {
    let full = screen.frame
    let visible = screen.visibleFrame
    let width = stripSize.width
    let height = min(stripSize.height, visible.height - edgeMargin * 2)
    let x = model.prefs.edge == "left" ? full.minX : full.maxX - width
    let y: CGFloat =
      switch model.prefs.resolvedHeight {
      case "top": visible.maxY - edgeMargin - height
      case "bottom": visible.minY + edgeMargin
      default: visible.midY - height / 2
      }
    return NSRect(x: x, y: y, width: width, height: height)
  }

  private func panelFrame(on screen: NSScreen) -> NSRect {
    let full = screen.frame
    let visible = screen.visibleFrame
    let width: CGFloat = 260
    let height = min(visible.height * 0.7, 620)
    let anchor = stripFrame(on: screen)
    var y: CGFloat =
      switch model.prefs.resolvedHeight {
      case "top": anchor.maxY - height
      case "bottom": anchor.minY
      default: anchor.midY - height / 2
      }
    y = min(max(y, visible.minY + 8), visible.maxY - height - 8)
    let x = model.prefs.edge == "left" ? full.minX : full.maxX - width
    return NSRect(x: x, y: y, width: width, height: height)
  }

  private func place() {
    guard let screen else { return }
    strip.setFrame(stripFrame(on: screen), display: true)
    if model.expanded { panel.setFrame(panelFrame(on: screen), display: true) }
  }

  private func stripResized(_ size: CGSize) {
    guard size != stripSize, size.height > 0 else { return }
    stripSize = CGSize(width: 8, height: max(32, size.height))
    place()
  }

  // MARK: opening and closing

  private func stripHover(_ inside: Bool) {
    openTimer?.invalidate()
    guard inside, model.prefs.openOnHover, !model.expanded else { return }
    // A short intent delay, so passing over the edge doesn't open it.
    openTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.expand(byHover: true, focus: false) }
    }
  }

  private func panelHover(_ inside: Bool) {
    closeTimer?.invalidate()
    guard !inside, model.expanded, openedByHover, !panel.isKeyWindow else { return }
    closeTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.collapse() }
    }
  }

  private func stripClicked() {
    guard model.prefs.openOnClick else { return }
    model.expanded ? collapse() : expand(byHover: false, focus: false)
  }

  private func hotKeyPressed() {
    guard model.prefs.openOnHotkey else { return }
    model.expanded ? collapse() : expand(byHover: false, focus: true)
  }

  private func escape() {
    if model.chatWith != nil {
      model.chatWith = nil
    } else {
      collapse()
    }
  }

  func expand(byHover: Bool, focus: Bool) {
    guard let screen, !model.expanded else { return }
    openTimer?.invalidate()
    closeTimer?.invalidate()
    openedByHover = byHover
    model.expanded = true
    let target = panelFrame(on: screen)
    if reduceMotion {
      panel.setFrame(target, display: true)
      panel.alphaValue = 0
      panel.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { $0.duration = 0.15; panel.animator().alphaValue = 1 }
    } else {
      let offset: CGFloat = model.prefs.edge == "left" ? -target.width : target.width
      panel.alphaValue = 1
      panel.setFrame(target.offsetBy(dx: offset, dy: 0), display: true)
      panel.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup {
        $0.duration = 0.15
        $0.timingFunction = CAMediaTimingFunction(name: .easeOut)
        panel.animator().setFrame(target, display: true)
      }
    }
    if focus {
      previousApp = NSWorkspace.shared.frontmostApplication
      panel.makeKey()
    }
    // Clicking anywhere outside closes it. Global mouse monitors need no permission.
    clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
      [weak self] _ in MainActor.assumeIsolated { self?.collapse() }
    }
  }

  func collapse() {
    guard model.expanded else { return }
    openTimer?.invalidate()
    closeTimer?.invalidate()
    if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
    clickMonitor = nil
    model.expanded = false
    let wasKey = panel.isKeyWindow
    let frame = panel.frame
    let offset: CGFloat = model.prefs.edge == "left" ? -frame.width : frame.width
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.15
      if self.reduceMotion {
        panel.animator().alphaValue = 0
      } else {
        panel.animator().setFrame(frame.offsetBy(dx: offset, dy: 0), display: true)
      }
    } completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        guard let self, !self.model.expanded else { return }
        self.panel.orderOut(nil)
        self.panel.alphaValue = 1
      }
    }
    // Hand the keyboard back to whatever you were using.
    if wasKey { previousApp?.activate() }
    previousApp = nil
  }
}
