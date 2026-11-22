import SwiftUI

// Something on the Add or Settings tab you can reach with ↑/↓: Space or Return presses it,
// ←/→ step through its choices. Its closures run later, so they must read state when called.
struct Control: Equatable {
  let id: String
  var press: () -> Void
  var adjust: ((Int) -> Void)?

  static func == (a: Control, b: Control) -> Bool { a.id == b.id }
}

// The controls on screen, top to bottom.
struct Controls: PreferenceKey {
  static let defaultValue: [Control] = []
  static func reduce(value: inout [Control], nextValue: () -> [Control]) { value += nextValue() }
}

extension View {
  func control(_ id: String, press: @escaping () -> Void, adjust: ((Int) -> Void)? = nil) -> some View {
    modifier(Outlined(control: Control(id: id, press: press, adjust: adjust)))
  }

  func control(_ id: String, toggle: Binding<Bool>) -> some View {
    control(id, press: { toggle.wrappedValue.toggle() })
  }

  // Return or Space moves on to the next choice; ←/→ go back and forth without wrapping.
  func control<Value: Equatable>(_ id: String, choice: Binding<Value>, from choices: [Value]) -> some View {
    let step = { (delta: Int, wrap: Bool) in
      let index = choices.firstIndex(of: choice.wrappedValue) ?? 0
      let next = wrap ? (index + delta) % choices.count : min(max(index + delta, 0), choices.count - 1)
      choice.wrappedValue = choices[next]
    }
    return control(id, press: { step(1, true) }, adjust: { step($0, false) })
  }
}

// The accent outline on the control picked with the keyboard.
private struct Outlined: ViewModifier {
  var control: Control
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @Environment(\.isEnabled) private var enabled

  func body(content: Content) -> some View {
    content
      .overlay {
        RoundedRectangle(cornerRadius: theme.controlRadius + 3)
          .strokeBorder(model.cursor == control.id ? theme.accent : .clear, lineWidth: 1.5)
          .padding(-3)
          .allowsHitTesting(false)
      }
      .id(control.id)
      .preference(key: Controls.self, value: enabled ? [control] : [])
  }
}

// A checkbox ↑/↓ can reach, named by its title unless that isn't unique.
struct Check: View {
  var title: String
  var isOn: Binding<Bool>
  var id: String?

  init(_ title: String, isOn: Binding<Bool>, id: String? = nil) {
    self.title = title
    self.isOn = isOn
    self.id = id
  }

  var body: some View {
    Toggle(title, isOn: isOn).control(id ?? title, toggle: isOn)
  }
}
