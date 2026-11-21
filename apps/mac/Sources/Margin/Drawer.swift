import AppKit
import Carbon.HIToolbox
import SwiftUI

// A borderless panel that never activates Margin on its own; it becomes key only when a
// text field needs the keyboard, or when opened with the hotkey.
final class DrawerPanel: NSPanel {
  var onEscape: (() -> Void)?
  // Keys for moving around the drawer; true when handled.
  var onKey: ((NSEvent) -> Bool)?

  override func keyDown(with event: NSEvent) {
    if onKey?(event) != true { super.keyDown(with: event) }
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
    if ["1", "2", "3"].contains(key), onKey?(event) == true { return true }
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
  private var stripSize = CGSize(width: 8, height: 32)
  private var openTimer: Timer?
  private var closeTimer: Timer?
  private var openedByHover = false
  private var previousApp: NSRunningApplication?
  private var clickMonitor: Any?
  private var hotKey: HotKey?

  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  init(model: AppModel) {
    self.model = model
    stripView = StripHostingView(rootView: AnyView(EmptyView()))
    panelView = TrackingHostingView(rootView: AnyView(EmptyView()))
    strip = DrawerPanel(content: stripView)
    panel = DrawerPanel(content: panelView)

    let onClose: () -> Void = { [weak self] in self?.collapse() }
    stripView.rootView = AnyView(Themed(model: model) { StripView() })
    panelView.rootView = AnyView(Themed(model: model) { PanelView(onClose: onClose) })

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

    let center = NotificationCenter.default
    center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: panel, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.model.drawerFocused = true }
    }
    center.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.model.drawerFocused = false }
    }
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
      _ = (model.prefs.appearance, model.prefs.edge, model.prefs.position, model.prefs.openOnHotkey)
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
    hotKey?.set(enabled: model.prefs.openOnHotkey)
    place()
  }

  // The screen you're working on: the one with the frontmost window.
  private var screen: NSScreen? { NSScreen.main ?? NSScreen.screens.first }

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
    // Opens downward from a strip in the top half, upward from one in the bottom half.
    let anchor = stripFrame(on: screen)
    var y = anchor.midY >= visible.midY ? anchor.maxY - height : anchor.minY
    y = min(max(y, visible.minY + 8), visible.maxY - height - 8)
    let x = model.prefs.edge == "left" ? full.minX : full.maxX - width
    return NSRect(x: x, y: y, width: width, height: height)
  }

  private func place() {
    guard let screen else { return }
    strip.setFrame(stripFrame(on: screen), display: true)
    if model.expanded { panel.setFrame(panelFrame(on: screen), display: true) }
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

  // ↑/↓ through friends, Return to chat, Tab or ⌘1–3 between tabs. While you're typing in
  // a field, keys stay with the field.
  private func key(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if flags.contains(.command) {
      guard let digit = event.charactersIgnoringModifiers.flatMap(Int.init), (1...3).contains(digit) else { return false }
      model.showTab([.friends, .add, .settings][digit - 1])
      return true
    }
    if panel.firstResponder is NSTextView { return false }
    let onList = model.chatWith == nil && model.tab == .friends && !model.needsSetup
    switch Int(event.keyCode) {
    case kVK_UpArrow where onList:
      model.moveSelection(-1)
    case kVK_DownArrow where onList:
      model.moveSelection(1)
    case kVK_Return where onList, kVK_ANSI_KeypadEnter where onList:
      guard let handle = model.selected else { return false }
      model.openChat(handle)
    case kVK_Tab where model.chatWith == nil && !model.needsSetup:
      model.cycleTab(flags.contains(.shift) ? -1 : 1)
    default:
      return false
    }
    return true
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
    model.selected = nil
    model.updates.drawerClosed()
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
