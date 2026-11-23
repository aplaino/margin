import AppKit
import Carbon.HIToolbox

// Moving around the drawer with the keyboard.
extension DrawerController {
  // ↑/↓ through friends or chats, Return to chat, Tab or ⌘1–4 between tabs. On Add and Settings ↑/↓
  // outline a control, Space or Return presses it and ←/→ change it. In a chat, ↑ from an
  // empty field outlines your last message and ⌘C copies it. While you're typing in a field,
  // keys stay with the field.
  func key(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let field = panel.firstResponder as? NSTextView
    if flags.contains(.command) {
      let key = event.charactersIgnoringModifiers?.lowercased()
      if key == "c", field == nil, let message = model.cursorMessage {
        model.copy(message)
        return true
      }
      guard let digit = key.flatMap(Int.init), (1...4).contains(digit) else { return false }
      model.showTab([.friends, .chats, .add, .settings][digit - 1])
      return true
    }
    guard !model.needsSetup, !model.showGuide else { return false }
    if model.chatWith != nil { return chatKey(event, field: field) }
    // On a profile, Return opens the chat; Tab still moves between tabs.
    if let profile = model.profileOf, field == nil {
      switch Int(event.keyCode) {
      case kVK_Return, kVK_ANSI_KeypadEnter:
        guard profile != model.me?.handle else { return false }
        model.openChat(profile)
      case kVK_Tab:
        model.cycleTab(flags.contains(.shift) ? -1 : 1)
      default:
        return false
      }
      return true
    }
    if field != nil {
      // Esc leaves a field on Add or Settings without closing the drawer.
      guard event.keyCode == kVK_Escape else { return false }
      panel.makeFirstResponder(nil)
      return true
    }
    let control = model.control
    let list = model.tab == .friends || model.tab == .chats
    switch Int(event.keyCode) {
    case kVK_UpArrow where list:
      model.moveSelection(-1)
    case kVK_DownArrow where list:
      model.moveSelection(1)
    // Return does what a click does: a friend's profile on Friends, the chat on Chats.
    case kVK_Return where list, kVK_ANSI_KeypadEnter where list:
      guard model.keyboardNav, let handle = model.selected else { return false }
      if model.tab == .chats { model.openChat(handle) } else { model.openProfile(handle) }
    case kVK_UpArrow:
      model.moveCursor(-1)
    case kVK_DownArrow:
      model.moveCursor(1)
    case kVK_Space, kVK_Return, kVK_ANSI_KeypadEnter:
      // With nothing outlined the key does nothing, rather than reaching SwiftUI, which would
      // press whichever button it has focused (the account card, at the top of Settings).
      control?.press()
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
  func chatKey(_ event: NSEvent, field: NSTextView?) -> Bool {
    let ids = (model.conversations[model.chatWith ?? ""] ?? []).map(\.id)
    if let field {
      guard event.keyCode == kVK_UpArrow, field.string.isEmpty, let last = ids.last else { return false }
      model.cursor = last
      model.keyboardNav = true
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
    case kVK_Delete, kVK_ForwardDelete:
      guard let message = model.cursorMessage else { return false }
      model.delete(message)
    default:
      // Arrow and function keys arrive as private-use characters, Return and Tab as controls.
      guard let typed = event.characters?.unicodeScalars.first,
        !CharacterSet.controlCharacters.contains(typed), !(0xF700...0xF8FF).contains(typed.value)
      else { return false }
      backToField(typing: event)
    }
    return true
  }

  func backToField(typing event: NSEvent?) {
    model.cursor = nil
    guard let field = editableField(in: panelView) else { return }
    panel.makeFirstResponder(field)
    if let event { panel.firstResponder?.keyDown(with: event) }
  }

  func editableField(in view: NSView) -> NSView? {
    if let field = view as? NSTextField, field.isEditable { return field }
    if let text = view as? NSTextView, text.isEditable { return text }
    return view.subviews.lazy.compactMap { self.editableField(in: $0) }.first
  }

  func escape() {
    if model.chatWith != nil {
      model.chatWith = nil
    } else if model.profileOf != nil {
      model.profileOf = nil
    } else if model.showThemeEditor {
      model.showThemeEditor = false
    } else if model.tab == .settings, model.settingsPage != nil {
      model.settingsPage = nil
    } else {
      collapse()
    }
  }
}
