import AppKit
import Carbon.HIToolbox
import SwiftUI

// A borderless panel that never activates Margin on its own; it becomes key only when a
// text field needs the keyboard, or when opened with the hotkey.
final class DrawerPanel: NSPanel {
  var onEscape: (() -> Void)?
  // Keys for moving around the drawer; true when handled. They're seen before any control
  // or field, which decide for themselves through onKey whether to let them through.
  var onKey: ((NSEvent) -> Bool)?

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, onKey?(event) == true { return }
    super.sendEvent(event)
  }

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

  // Margin has no menu bar, which is where ⌘C, ⌘V and friends normally come from, so the
  // drawer sends those actions to whatever has focus itself.
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard flags.contains(.command), let key = event.charactersIgnoringModifiers?.lowercased() else {
      return super.performKeyEquivalent(with: event)
    }
    if onKey?(event) == true { return true }
    let action: Selector? =
      switch (key, flags.contains(.shift)) {
      case ("c", false): #selector(NSText.copy(_:))
      case ("v", false): #selector(NSText.paste(_:))
      case ("x", false): #selector(NSText.cut(_:))
      case ("a", false): #selector(NSResponder.selectAll(_:))
      case ("z", false): Selector(("undo:"))
      case ("z", true): Selector(("redo:"))
      default: nil
      }
    if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
    return super.performKeyEquivalent(with: event)
  }
}

// Hosts SwiftUI and reports the pointer entering and leaving, even when Margin isn't active.
class TrackingHostingView<Content: View>: NSHostingView<Content> {
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

// The strip handles its own mouse: a click opens the drawer, a drag moves the strip along
// the edge, or across to the other edge. Screen coordinates keep the drag steady while the
// window itself moves.
final class StripHostingView: TrackingHostingView<AnyView> {
  var onPress: (() -> Void)?
  var onClick: (() -> Void)?
  var onDrag: ((NSPoint) -> Void)?
  var onDragEnd: (() -> Void)?
  private var downAt: NSPoint?
  private var dragging = false

  override func mouseDown(with event: NSEvent) {
    downAt = NSEvent.mouseLocation
    dragging = false
    onPress?()
  }

  override func mouseDragged(with event: NSEvent) {
    guard let downAt else { return }
    let point = NSEvent.mouseLocation
    if !dragging, hypot(point.x - downAt.x, point.y - downAt.y) > 3 { dragging = true }
    if dragging { onDrag?(point) }
  }

  override func mouseUp(with event: NSEvent) {
    if dragging { onDragEnd?() } else if downAt != nil { onClick?() }
    downAt = nil
    dragging = false
  }
}

// Reports the pointer entering and leaving a view it doesn't own (the menu bar item's button).
final class HoverTracker: NSResponder {
  var onHover: ((Bool) -> Void)?
  override func mouseEntered(with event: NSEvent) { onHover?(true) }
  override func mouseExited(with event: NSEvent) { onHover?(false) }
}

// AppKit actions need an Objective-C target.
final class ActionTarget: NSObject {
  let action: () -> Void
  init(_ action: @escaping () -> Void) { self.action = action }
  @objc func fire() { action() }
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
  private let stripView: StripHostingView
  private let panelView: TrackingHostingView<AnyView>
  private let peekPanel: DrawerPanel
  private let peekView: TrackingHostingView<AnyView>
  private var peekTimer: Timer?
  private let peekSize = CGSize(width: 250, height: 34)
  private var stripSize = CGSize(width: 8, height: 32)
  private var openTimer: Timer?
  private var closeTimer: Timer?
  private var openedByHover = false
  private var previousApp: NSRunningApplication?
  private var clickMonitor: Any?
  private var hotKey: HotKey?
  // The menu bar item, while Margin is placed there.
  private var statusItem: NSStatusItem?
  private let hoverTracker = HoverTracker()
  private var clickTarget: ActionTarget?
  private var hiddenTimer: Timer?
  private var lastPlacement = ""
  private var welcome: WelcomeWindow?
  private var strandedCheck: Timer?

  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  init(model: AppModel) {
    self.model = model
    stripView = StripHostingView(rootView: AnyView(EmptyView()))
    panelView = TrackingHostingView(rootView: AnyView(EmptyView()))
    strip = DrawerPanel(content: stripView)
    panel = DrawerPanel(content: panelView)
    peekView = TrackingHostingView(rootView: AnyView(EmptyView()))
    peekPanel = DrawerPanel(content: peekView)

    let onClose: () -> Void = { [weak self] in self?.collapse() }
    stripView.rootView = AnyView(Themed(model: model) { StripView() })
    panelView.rootView = AnyView(Themed(model: model) { PanelView(onClose: onClose) })
    let onPeek: () -> Void = { [weak self] in self?.openPeek() }
    peekView.rootView = AnyView(Themed(model: model) { PeekView(onOpen: onPeek) })
    peekView.sizingOptions = []
    peekView.onHover = { [weak self] inside in self?.peekHover(inside) }
    hoverTracker.onHover = { [weak self] inside in self?.stripHover(inside) }

    // The windows are sized here, not by SwiftUI's constraints.
    stripView.sizingOptions = []
    panelView.sizingOptions = []
    stripView.onHover = { [weak self] inside in self?.stripHover(inside) }
    stripView.onPress = { [weak self] in self?.openTimer?.invalidate() }
    stripView.onClick = { [weak self] in self?.stripClicked() }
    stripView.onDrag = { [weak self] point in self?.dragged(to: point) }
    stripView.onDragEnd = { [weak self] in self?.dragEnded() }
    panelView.onHover = { [weak self] inside in self?.panelHover(inside) }
    panel.onEscape = { [weak self] in self?.escape() }
    panel.onKey = { [weak self] event in self?.key(event) ?? false }

    hotKey = HotKey { [weak self] in self?.hotKeyPressed() }
    observePrefs()
    observeStrip()
    observePeek()
    observeMenuBar()

    let center = NotificationCenter.default
    // Clicking anywhere in the drawer gives it the keyboard (not just a text field), so the
    // arrow keys work on whatever you clicked into. Margin isn't activated, so the app you were
    // in stays frontmost and gets the keyboard back when the drawer closes.
    panel.becomesKeyOnlyIfNeeded = false
    center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: panel, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.model.drawerFocused = true
        if self.previousApp == nil { self.previousApp = NSWorkspace.shared.frontmostApplication }
      }
    }
    center.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.model.drawerFocused = false }
    }
    center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) {
      [weak self] _ in
      MainActor.assumeIsolated {
        self?.place(movingDrawer: true)
        if self?.statusItem != nil { self?.menuBarVisibilityChanged() }
      }
    }
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.place() } }
    center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main) {
      [weak self] note in
      MainActor.assumeIsolated {
        guard let self, let window = note.object as? NSWindow, window === self.statusItem?.button?.window else { return }
        self.menuBarVisibilityChanged()
      }
    }

    place()
    if !model.prefs.welcomed && !model.prefs.setupDone { showWelcome() }
    // The strip was once found far off the only screen, out of reach, with no display having
    // come or gone; if it's ever on no screen at all, put it back.
    strandedCheck = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.strip.isVisible, !self.model.expanded else { return }
        if !NSScreen.screens.contains(where: { $0.frame.intersects(self.strip.frame) }) { self.place() }
      }
    }
  }

  // First launch: say where Margin lives, then open the drawer there with the strip or menu
  // bar item pulsing, and carry on setup inside it (the welcome page is already done).
  private func showWelcome() {
    let window = WelcomeWindow(model: model) { [weak self] in
      guard let self else { return }
      self.model.prefs.welcomed = true
      self.welcome = nil
      if self.model.setupStep == .welcome { self.model.setupStep = .guide }
      // Give a new menu bar item a moment to take its place.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        self?.expand(byHover: false, focus: true)
        self?.model.pulse += 1
      }
    }
    welcome = window
    window.show()
  }

  // Re-applies settings that affect the windows whenever they change.
  private func observePrefs() {
    withObservationTracking {
      _ = (
        model.prefs.appearance, model.prefs.edge, model.prefs.position, model.prefs.openOnHotkey,
        model.prefs.menuBar
      )
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
      switch model.prefs.appearance {
      case "light": NSAppearance(named: .aqua)
      case "dark": NSAppearance(named: .darkAqua)
      default: nil
      }
    strip.appearance = appearance
    panel.appearance = appearance
    peekPanel.appearance = appearance
    hotKey?.set(enabled: model.prefs.openOnHotkey)
    setMenuBar(model.prefs.menuBar)
    let placement = "\(model.prefs.menuBar) \(model.prefs.edge) \(model.prefs.resolvedPosition)"
    place(movingDrawer: placement != lastPlacement)
    lastPlacement = placement
  }

  // MARK: the menu bar item

  private func setMenuBar(_ on: Bool) {
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
  private func menuBarVisibilityChanged() {
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
  private var menuBarItemCrowdedOut: Bool {
    guard let window = statusItem?.button?.window else { return true }
    guard let screen = window.screen, let left = screen.auxiliaryTopLeftArea,
      let right = screen.auxiliaryTopRightArea
    else { return false }
    let notch = (screen.frame.minX + left.width)...(screen.frame.maxX - right.width)
    return notch.contains(window.frame.midX)
  }

  private var inMenuBar: Bool { statusItem != nil && !model.menuBarHidden }

  // Draws the item again whenever what it shows changes: friends and their status, unread,
  // sign-in, connection, theme.
  private func observeMenuBar() {
    withObservationTracking {
      _ = (
        model.onlineFriends.map(\.presence.status), model.unreadTotal, model.signedIn, model.me?.connection,
        model.prefs.style, model.prefs.accent
      )
    } onChange: { [weak self] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.drawMenuBar()
          self?.observeMenuBar()
        }
      }
    }
    withObservationTracking {
      _ = model.pulse
    } onChange: { [weak self] in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.pulseMenuBar() } }
    }
  }

  // The image follows the menu bar's own light or dark look, which depends on the wallpaper,
  // not on Margin's appearance setting. macOS sizes the item to the image.
  private func drawMenuBar(glow: Double = 0) {
    guard let button = statusItem?.button else { return }
    let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
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
  private func pulseMenuBar() {
    defer { observeMenuBar() }
    guard statusItem != nil else { return }
    let frames = reduceMotion ? 0 : 45
    for frame in 0...frames {
      let t = Double(frame) / 30
      let glow = frame == frames ? 0 : sin(.pi * (t.truncatingRemainder(dividingBy: 0.5) / 0.5))
      DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.drawMenuBar(glow: glow) }
    }
  }
  private var menuBarAnchor: NSRect? { inMenuBar ? statusItem?.button?.window?.frame : nil }

  // Where a window slides in from: up under the menu bar, or off the screen edge.
  private func tucked(_ frame: NSRect) -> NSRect {
    if model.atTop { return frame.offsetBy(dx: 0, dy: frame.height + 8) }
    return frame.offsetBy(dx: model.prefs.edge == "left" ? -frame.width : frame.width, dy: 0)
  }

  // The menu bar item's screen, or the one you're working on: the one with the frontmost window.
  private var screen: NSScreen? {
    (inMenuBar ? statusItem?.button?.window?.screen : nil) ?? NSScreen.main ?? NSScreen.screens.first
  }

  private func stripFrame(on screen: NSScreen) -> NSRect {
    let full = screen.frame
    let visible = screen.visibleFrame
    let width = stripSize.width
    let height = min(stripSize.height, visible.height)
    let x = model.prefs.edge == "left" ? full.minX : full.maxX - width
    // 0 is right under the menu bar, 1 the bottom of the screen.
    let (top, bottom) = travel(on: screen, height: height)
    let y = top > bottom ? top - CGFloat(model.prefs.resolvedPosition) * (top - bottom) : visible.midY - height / 2
    return NSRect(x: x, y: y, width: width, height: height)
  }

  // The lowest y of the strip's frame at the top and at the bottom of its travel.
  private func travel(on screen: NSScreen, height: CGFloat) -> (top: CGFloat, bottom: CGFloat) {
    let visible = screen.visibleFrame
    return (visible.maxY - height, visible.minY)
  }

  private func panelFrame(on screen: NSScreen) -> NSRect {
    let full = screen.frame
    let visible = screen.visibleFrame
    let width: CGFloat = 260
    let height = min(visible.height * 0.7, 620)
    // Drops down from the menu bar item, kept on screen.
    if let anchor = menuBarAnchor {
      let x = min(max(anchor.midX - width / 2, full.minX + 8), full.maxX - width - 8)
      return NSRect(x: x, y: visible.maxY - height, width: width, height: height)
    }
    // Opens downward from a strip in the top half, upward from one in the bottom half.
    let anchor = stripFrame(on: screen)
    var y = anchor.midY >= visible.midY ? anchor.maxY - height : anchor.minY
    y = min(max(y, visible.minY + 8), visible.maxY - height - 8)
    let x = model.prefs.edge == "left" ? full.minX : full.maxX - width
    return NSRect(x: x, y: y, width: width, height: height)
  }

  // An open drawer stays where it opened while the strip or menu bar item changes size (a
  // friend coming online, a chat being read); it moves only with the screen or placement.
  private func place(movingDrawer: Bool = false) {
    if model.atTop != inMenuBar { model.atTop = inMenuBar }
    guard let screen else { return }
    if inMenuBar {
      strip.orderOut(nil)
    } else {
      strip.setFrame(stripFrame(on: screen), display: true)
      if !strip.isVisible { strip.orderFrontRegardless() }
    }
    if model.expanded, movingDrawer { panel.setFrame(panelFrame(on: screen), display: true) }
  }

  // MARK: sliding in and out

  // A soft ease-out in (fast start, long settle) and a quicker ease-in out, fading as they go.
  private let easeOut = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
  private let easeIn = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.75, 0)

  private func slideIn(_ window: NSWindow, to target: NSRect, duration: TimeInterval = 0.32) {
    window.setFrame(reduceMotion ? target : tucked(target), display: true)
    window.alphaValue = 0
    window.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = reduceMotion ? 0.15 : duration
      context.timingFunction = easeOut
      context.allowsImplicitAnimation = true
      window.animator().alphaValue = 1
      if !reduceMotion { window.animator().setFrame(target, display: true) }
    }
  }

  private func slideOut(_ window: NSWindow, then done: @escaping () -> Void) {
    let frame = window.frame
    NSAnimationContext.runAnimationGroup { context in
      context.duration = reduceMotion ? 0.12 : 0.22
      context.timingFunction = easeIn
      window.animator().alphaValue = 0
      if !reduceMotion { window.animator().setFrame(tucked(frame), display: true) }
    } completionHandler: {
      MainActor.assumeIsolated { done() }
    }
  }

  // The strip is as tall as its dots and counts: it grows as friends come online.
  private func observeStrip() {
    withObservationTracking {
      _ = (model.onlineFriends.count, model.unreadTotal, model.signedIn)
    } onChange: { [weak self] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.resizeStrip()
          self?.observeStrip()
        }
      }
    }
    resizeStrip()
  }

  // Worked out from what the strip shows, with the same theme metrics it's drawn with.
  private func stripHeight() -> CGFloat {
    let metrics = model.prefs.style.theme(dark: true, accent: .clear)
    guard model.signedIn else { return 32 }
    let online = model.onlineFriends.count
    var items = Array(repeating: metrics.dot, count: min(online, 12))
    if online > 12 { items.append(metrics.stripLabel) }
    if model.unreadTotal > 0 { items.append(metrics.stripLabel) }
    let content = items.reduce(0, +) + metrics.stripSpacing * CGFloat(max(0, items.count - 1))
    return max(32, content + metrics.stripPadding * 2)
  }

  private func resizeStrip() {
    let height = stripHeight()
    guard height != stripSize.height else { return }
    stripSize = CGSize(width: 8, height: height)
    place()
  }

  // MARK: the message peek

  private func observePeek() {
    withObservationTracking {
      _ = model.peek
    } onChange: { [weak self] in
      DispatchQueue.main.asyncAfter(deadline: .now()) {
        MainActor.assumeIsolated {
          self?.model.peek == nil ? self?.hidePeek() : self?.showPeek()
          self?.observePeek()
        }
      }
    }
  }

  private func peekFrame() -> NSRect {
    // Under the menu bar item, kept on screen.
    if let anchor = menuBarAnchor, let screen {
      let full = screen.frame
      let x = min(max(anchor.maxX - peekSize.width, full.minX + 8), full.maxX - peekSize.width - 8)
      return NSRect(x: x, y: screen.visibleFrame.maxY - peekSize.height - 6, width: peekSize.width, height: peekSize.height)
    }
    let anchor = strip.frame
    let x = model.prefs.edge == "left" ? anchor.maxX - 1 : anchor.minX - peekSize.width + 1
    let y = anchor.maxY - peekSize.height
    return NSRect(origin: CGPoint(x: x, y: y), size: peekSize)
  }

  private func showPeek() {
    guard !model.expanded else {
      model.peek = nil
      return
    }
    if !peekPanel.isVisible {
      slideIn(peekPanel, to: peekFrame(), duration: 0.36)
      if !model.atTop { strip.orderFrontRegardless() }
    }
    schedulePeekHide(after: 4)
  }

  private func schedulePeekHide(after seconds: TimeInterval) {
    peekTimer?.invalidate()
    peekTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.model.peek = nil }
    }
  }

  // Hovering keeps it out; leaving gives you a moment before it goes.
  private func peekHover(_ inside: Bool) {
    guard model.peek != nil else { return }
    if inside { peekTimer?.invalidate() } else { schedulePeekHide(after: 1.5) }
  }

  private func hidePeek() {
    peekTimer?.invalidate()
    guard peekPanel.isVisible else { return }
    slideOut(peekPanel) { [weak self] in
      guard let self, self.model.peek == nil else { return }
      self.peekPanel.orderOut(nil)
      self.peekPanel.alphaValue = 1
    }
  }

  private func openPeek() {
    guard let handle = model.peek?.handle else { return }
    model.peek = nil
    expand(byHover: false, focus: false)
    model.openChat(handle)
  }

  // MARK: dragging

  private var dragEdge: String?

  private func dragged(to point: NSPoint) {
    guard let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? screen else { return }
    if dragEdge == nil {
      openTimer?.invalidate()
      collapse()
      NSCursor.closedHand.push()
    }
    let edge = point.x < screen.frame.midX ? "left" : "right"
    dragEdge = edge
    let (top, bottom) = travel(on: screen, height: stripSize.height)
    let y = min(max(point.y - stripSize.height / 2, bottom), max(top, bottom))
    let x = edge == "left" ? screen.frame.minX : screen.frame.maxX - stripSize.width
    strip.setFrame(NSRect(x: x, y: y, width: stripSize.width, height: stripSize.height), display: true)
  }

  private func dragEnded() {
    guard let edge = dragEdge else { return }
    dragEdge = nil
    NSCursor.pop()
    guard let screen = strip.screen ?? screen else { return }
    let (top, bottom) = travel(on: screen, height: stripSize.height)
    let fraction = top > bottom ? Double((top - strip.frame.minY) / (top - bottom)) : 0.5
    model.prefs.position = min(max(fraction, 0), 1)
    model.prefs.edge = edge
  }

  // MARK: opening and closing

  private func stripHover(_ inside: Bool) {
    model.stripHovered = inside
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

  // A click on the menu bar item gives the drawer the keyboard, as every menu does; a click
  // on the edge strip doesn't, so it never takes focus from your work by surprise.
  private func stripClicked() {
    guard model.prefs.openOnClick else { return }
    model.expanded ? collapse() : expand(byHover: false, focus: inMenuBar)
  }

  private func hotKeyPressed() {
    guard model.prefs.openOnHotkey else { return }
    model.expanded ? collapse() : expand(byHover: false, focus: true)
  }

  // ↑/↓ through friends, Return to chat, Tab or ⌘1–3 between tabs. On Add and Settings ↑/↓
  // outline a control, Space or Return presses it and ←/→ change it. In a chat, ↑ from an
  // empty field outlines your last message and ⌘C copies it. While you're typing in a field,
  // keys stay with the field.
  private func key(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let field = panel.firstResponder as? NSTextView
    if flags.contains(.command) {
      let key = event.charactersIgnoringModifiers?.lowercased()
      if key == "c", field == nil, let message = model.cursorMessage {
        model.copy(message)
        return true
      }
      guard let digit = key.flatMap(Int.init), (1...3).contains(digit) else { return false }
      model.showTab([.friends, .add, .settings][digit - 1])
      return true
    }
    guard !model.needsSetup, !model.showGuide else { return false }
    if model.chatWith != nil { return chatKey(event, field: field) }
    if field != nil {
      // Esc leaves a field on Add or Settings without closing the drawer.
      guard event.keyCode == kVK_Escape else { return false }
      panel.makeFirstResponder(nil)
      return true
    }
    let control = model.control
    switch Int(event.keyCode) {
    case kVK_UpArrow where model.tab == .friends:
      model.moveSelection(-1)
    case kVK_DownArrow where model.tab == .friends:
      model.moveSelection(1)
    case kVK_Return where model.tab == .friends, kVK_ANSI_KeypadEnter where model.tab == .friends:
      guard let handle = model.selected else { return false }
      model.openChat(handle)
    case kVK_UpArrow:
      model.moveCursor(-1)
    case kVK_DownArrow:
      model.moveCursor(1)
    case kVK_Space, kVK_Return, kVK_ANSI_KeypadEnter:
      guard let control else { return false }
      control.press()
    case kVK_LeftArrow, kVK_RightArrow:
      guard let adjust = control?.adjust else { return false }
      adjust(event.keyCode == kVK_LeftArrow ? -1 : 1)
    case kVK_Tab:
      model.cycleTab(flags.contains(.shift) ? -1 : 1)
    default:
      return false
    }
    return true
  }

  // ↑ from an empty message field walks back through the chat; ↓ past the last message, Esc
  // or typing goes back to the field.
  private func chatKey(_ event: NSEvent, field: NSTextView?) -> Bool {
    let ids = (model.conversations[model.chatWith ?? ""] ?? []).map(\.id)
    if let field {
      guard event.keyCode == kVK_UpArrow, field.string.isEmpty, let last = ids.last else { return false }
      model.cursor = last
      panel.makeFirstResponder(nil)
      return true
    }
    guard let cursor = model.cursor, let index = ids.firstIndex(of: cursor) else { return false }
    switch Int(event.keyCode) {
    case kVK_UpArrow:
      model.cursor = ids[max(index - 1, 0)]
    case kVK_DownArrow where index < ids.count - 1:
      model.cursor = ids[index + 1]
    case kVK_DownArrow, kVK_Escape:
      backToField(typing: nil)
    default:
      // Arrow and function keys arrive as private-use characters, Return and Tab as controls.
      guard let typed = event.characters?.unicodeScalars.first,
        !CharacterSet.controlCharacters.contains(typed), !(0xF700...0xF8FF).contains(typed.value)
      else { return false }
      backToField(typing: event)
    }
    return true
  }

  private func backToField(typing event: NSEvent?) {
    model.cursor = nil
    guard let field = editableField(in: panelView) else { return }
    panel.makeFirstResponder(field)
    if let event { panel.firstResponder?.keyDown(with: event) }
  }

  private func editableField(in view: NSView) -> NSView? {
    if let field = view as? NSTextField, field.isEditable { return field }
    if let text = view as? NSTextView, text.isEditable { return text }
    return view.subviews.lazy.compactMap { self.editableField(in: $0) }.first
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
    model.peek = nil
    model.expanded = true
    slideIn(panel, to: panelFrame(on: screen))
    statusItem?.button?.highlight(true)
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
    model.selected = nil
    model.cursor = nil
    model.updates.drawerClosed()
    let wasKey = panel.isKeyWindow
    statusItem?.button?.highlight(false)
    slideOut(panel) { [weak self] in
      guard let self, !self.model.expanded else { return }
      self.panel.orderOut(nil)
      self.panel.alphaValue = 1
    }
    // Hand the keyboard back to whatever you were using.
    if wasKey { previousApp?.activate() }
    previousApp = nil
  }
}
