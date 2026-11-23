import AppKit
import Carbon.HIToolbox
import SwiftUI
import os

// One line per click on the strip or menu bar item, desktop switch and skipped opening, so a
// drawer that doesn't respond can be explained from the log (`log show --predicate
// 'subsystem == "dev.margin.app"'`). Only the drawer's state and frames, never names or text.
private let drawerLog = Logger(subsystem: "dev.margin.app", category: "drawer")

@MainActor
final class DrawerController {
  let model: AppModel
  let strip: DrawerPanel
  let panel: DrawerPanel
  let stripView: StripHostingView
  let panelView: TrackingHostingView<AnyView>
  let peekPanel: DrawerPanel
  let peekView: TrackingHostingView<AnyView>
  var peekTimer: Timer?
  let peekSize = CGSize(width: 250, height: 34)
  var stripSize = CGSize(width: 8, height: 32)
  var openTimer: Timer?
  var closeTimer: Timer?
  var openedByHover = false
  var previousApp: NSRunningApplication?
  var clickMonitor: Any?
  var hotKey: HotKey?
  // The menu bar item, while Margin is placed there.
  var statusItem: NSStatusItem?
  let hoverTracker = HoverTracker()
  var clickTarget: ActionTarget?
  var hiddenTimer: Timer?
  var lastPlacement = ""
  // What the menu bar image last showed, so an update that changes nothing visible (friends'
  // presence arrives every few seconds) doesn't render it again.
  var lastMenuBarLook: MenuBarLook?
  var welcome: WelcomeWindow?
  var strandedCheck: Timer?

  var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

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
    panel.onPointer = { [weak self] in self?.model.pointerUsed() }

    hotKey = HotKey { [weak self] in self?.hotKeyPressed() }
    observePrefs()
    observeStrip()
    observePeek()
    observeMenuBar()
    observePulse()

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
    // Before Margin becomes active (an alert, the colour picker), its windows are told to
    // come to this desktop, so macOS doesn't switch to the desktop one was left on.
    center.addObserver(forName: NSApplication.willBecomeActiveNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.keepOnThisDesktop() }
    }
    // Another desktop: the menu bar item may have moved or come back from under the notch.
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        drawerLog.notice("desktop changed: \(self.stateLine, privacy: .public)")
        if self.statusItem != nil { self.menuBarVisibilityChanged() }
        self.repairDesktops()
      }
    }
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
  func showWelcome() {
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
  func observePrefs() {
    withObservationTracking {
      _ = (
        model.prefs.appearance, model.prefs.edge, model.prefs.position, model.prefs.openOnHotkey,
        model.prefs.menuBar, model.prefs.alwaysDark
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

  func applyPrefs() {
    // A theme that's always dark gets a dark window too, so system controls match it.
    let appearance: NSAppearance? =
      switch model.prefs.alwaysDark ? "dark" : model.prefs.appearance {
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

  // Where a window slides in from: up under the menu bar, or off the screen edge.
  func tucked(_ frame: NSRect) -> NSRect {
    if model.atTop { return frame.offsetBy(dx: 0, dy: frame.height + 8) }
    return frame.offsetBy(dx: model.prefs.edge == "left" ? -frame.width : frame.width, dy: 0)
  }

  // The menu bar item's screen, or the one you're working on: the one with the frontmost window.
  var screen: NSScreen? {
    (inMenuBar ? statusItem?.button?.window?.screen : nil) ?? NSScreen.main ?? NSScreen.screens.first
  }

  func stripFrame(on screen: NSScreen) -> NSRect {
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
  func travel(on screen: NSScreen, height: CGFloat) -> (top: CGFloat, bottom: CGFloat) {
    let visible = screen.visibleFrame
    return (visible.maxY - height, visible.minY)
  }

  func panelFrame(on screen: NSScreen) -> NSRect {
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
  func place(movingDrawer: Bool = false) {
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
  let easeOut = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
  let easeIn = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.75, 0)

  func slideIn(_ window: NSWindow, to target: NSRect, duration: TimeInterval = 0.32) {
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

  func slideOut(_ window: NSWindow, then done: @escaping () -> Void) {
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
  func observeStrip() {
    withObservationTracking {
      _ = (model.onlineFriends.count, model.unreadTotal, model.signedIn, model.prefs.style, model.prefs.customTheme)
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
  func stripHeight() -> CGFloat {
    let metrics = model.prefs.theme(dark: true)
    guard model.signedIn else { return 32 }
    let online = model.onlineFriends.count
    var items = Array(repeating: metrics.dot, count: min(online, 12))
    if online > 12 { items.append(metrics.stripLabel) }
    if model.unreadTotal > 0 { items.append(metrics.stripLabel) }
    let content = items.reduce(0, +) + metrics.stripSpacing * CGFloat(max(0, items.count - 1))
    return max(32, content + metrics.stripPadding * 2)
  }

  func resizeStrip() {
    let height = stripHeight()
    guard height != stripSize.height else { return }
    stripSize = CGSize(width: 8, height: height)
    place()
  }

  // MARK: the message peek

  func observePeek() {
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

  func peekFrame() -> NSRect {
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

  // Adding or rearranging desktops in Mission Control can leave windows that already exist on
  // only some desktops, although they're set to be on all of them (new windows are placed on
  // all). Any of the drawer's windows that should be showing and isn't on this desktop is
  // ordered out and straight back in, in the same turn so it doesn't blink, which puts it on
  // every desktop again. Hidden ones are left hidden, and nothing takes focus.
  func repairDesktops() {
    let windows: [(window: NSWindow, name: String, showing: Bool)] = [
      (strip, "strip", !inMenuBar), (panel, "drawer", model.expanded), (peekPanel, "peek", model.peek != nil),
    ]
    for (window, name, showing) in windows where showing && !window.isOnActiveSpace {
      window.orderOut(nil)
      window.orderFrontRegardless()
      drawerLog.notice(
        "put the \(name, privacy: .public) back on this desktop (now here: \(window.isOnActiveSpace)): \(self.stateLine, privacy: .public)")
    }
  }

  func showPeek() {
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

  func schedulePeekHide(after seconds: TimeInterval) {
    peekTimer?.invalidate()
    peekTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.model.peek = nil }
    }
  }

  // Hovering keeps it out; leaving gives you a moment before it goes.
  func peekHover(_ inside: Bool) {
    guard model.peek != nil else { return }
    if inside { peekTimer?.invalidate() } else { schedulePeekHide(after: 1.5) }
  }

  func hidePeek() {
    peekTimer?.invalidate()
    guard peekPanel.isVisible else { return }
    slideOut(peekPanel) { [weak self] in
      guard let self, self.model.peek == nil else { return }
      self.peekPanel.orderOut(nil)
      self.peekPanel.alphaValue = 1
    }
  }

  func openPeek() {
    guard let handle = model.peek?.handle else { return }
    model.peek = nil
    expand(byHover: false, focus: false)
    // Messages live on Chats, so that's where Back goes from here.
    model.showTab(.chats)
    model.openChat(handle)
  }

  // MARK: dragging

  var dragEdge: String?

  func dragged(to point: NSPoint) {
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

  func dragEnded() {
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

  func stripHover(_ inside: Bool) {
    model.stripHovered = inside
    openTimer?.invalidate()
    guard inside, model.prefs.openOnHover, !model.expanded else { return }
    // A short intent delay, so passing over the edge doesn't open it.
    openTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.expand(byHover: true, focus: false) }
    }
  }

  func panelHover(_ inside: Bool) {
    closeTimer?.invalidate()
    // Not while you're picking a colour in the colour window.
    guard !inside, model.expanded, openedByHover, !panel.isKeyWindow, !ColorPanel.shared.isOpen else { return }
    closeTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.collapse() }
    }
  }

  // A click on the menu bar item gives the drawer the keyboard, as every menu does; a click
  // on the edge strip doesn't, so it never takes focus from your work by surprise.
  func stripClicked() {
    drawerLog.notice("click: \(self.stateLine, privacy: .public)")
    guard model.prefs.openOnClick else { return }
    // Marked open but not on this screen (macOS hid it during a call, or it's on another
    // desktop): it's closed as far as you can see, so this click opens it.
    if model.expanded, !(panel.isVisible && panel.isOnActiveSpace) { collapse() }
    model.expanded ? collapse() : expand(byHover: false, focus: inMenuBar)
  }

  // Opening the drawer must never take you to another desktop. macOS switches to "a Space
  // with open windows for the application" when an app becomes active, and Margin can own
  // windows that stay on one desktop: an alert or save panel, the colour picker, and windows
  // macOS keeps for text input. Those now move to the desktop you're on instead, and the
  // drawer's own windows are put back on every desktop in case anything changed that.
  func keepOnThisDesktop() {
    for window in [strip, panel, peekPanel] as [NSWindow] where window.collectionBehavior != DrawerPanel.everyDesktop {
      window.collectionBehavior = DrawerPanel.everyDesktop
    }
    // The menu bar item's own window is macOS's to place, so it's left alone.
    let item = statusItem?.button?.window
    for window in NSApp.windows
    where window !== item && window.level < .statusBar && !window.collectionBehavior.contains(.canJoinAllSpaces) {
      window.collectionBehavior.insert(.moveToActiveSpace)
    }
  }

  // What the drawer and menu bar item are doing, for the log.
  var stateLine: String {
    let item = statusItem?.button?.window
    return [
      "expanded=\(model.expanded)", "panelVisible=\(panel.isVisible)", "panelOnDesktop=\(panel.isOnActiveSpace)",
      "menuBar=\(statusItem != nil)", "hiddenItem=\(model.menuBarHidden)",
      "item=\(item.map { NSStringFromRect($0.frame) } ?? "none")", "itemScreen=\(item?.screen != nil)",
      "itemVisible=\(item?.occlusionState.contains(.visible) ?? false)", "openOnClick=\(model.prefs.openOnClick)",
      "screens=\(NSScreen.screens.count)", "active=\(NSApp.isActive)",
      "panelEveryDesktop=\(panel.collectionBehavior == DrawerPanel.everyDesktop)",
      "windows=\(NSApp.windows.count)",
    ].joined(separator: " ")
  }

  func hotKeyPressed() {
    guard model.prefs.openOnHotkey else { return }
    model.expanded ? collapse() : expand(byHover: false, focus: true)
  }

  func expand(byHover: Bool, focus: Bool) {
    guard let screen, !model.expanded else {
      drawerLog.notice("open skipped: \(self.stateLine, privacy: .public)")
      return
    }
    openTimer?.invalidate()
    closeTimer?.invalidate()
    keepOnThisDesktop()
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
