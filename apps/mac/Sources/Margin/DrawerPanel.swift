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
  // The pointer moved, clicked or scrolled inside the drawer.
  var onPointer: (() -> Void)?

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, onKey?(event) == true { return }
    if [.mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel].contains(event.type) { onPointer?() }
    super.sendEvent(event)
  }

  init(content: NSView) {
    super.init(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    collectionBehavior = Self.everyDesktop
    backgroundColor = .clear
    isOpaque = false
    hasShadow = false
    hidesOnDeactivate = false
    becomesKeyOnlyIfNeeded = true
    isMovable = false
    acceptsMouseMovedEvents = true
    contentView = content
  }

  // On every desktop and over full-screen apps, never moved by Mission Control.
  static let everyDesktop: NSWindow.CollectionBehavior = [
    .canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle,
  ]

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
