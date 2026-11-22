import AppKit
import SwiftUI

// Settings laid out like System Settings: titled groups on rounded cards, a label on the left
// and its control on the right of each row.

struct SettingsGroup<Content: View>: View {
  var title: String?
  @ViewBuilder var content: () -> Content
  @Environment(\.theme) private var theme

  init(_ title: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.title = title
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      if let title { SectionLabel(title).padding(.leading, 2) }
      VStack(alignment: .leading, spacing: 0) { content() }
        .padding(.horizontal, 10).padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: theme.controlRadius + 2).fill(theme.surface))
    }
    .padding(.top, 6)
  }
}

struct SettingsRow<Control: View>: View {
  var label: String
  var last = false
  @ViewBuilder var control: () -> Control
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text(label)
        Spacer(minLength: 6)
        control()
      }
      .padding(.vertical, 6)
      if !last { Divider().overlay(theme.divider) }
    }
  }
}

// Auto, Light and Dark as little windows, like System Settings → Appearance.
struct AppearanceTiles: View {
  @Binding var selection: String
  @Environment(\.theme) private var theme

  var body: some View {
    HStack(spacing: 0) {
      tile("Auto", "system")
      Spacer(minLength: 4)
      tile("Light", "light")
      Spacer(minLength: 4)
      tile("Dark", "dark")
    }
    .padding(.vertical, 8)
    .control("Appearance", choice: $selection, from: ["system", "light", "dark"])
  }

  private func tile(_ name: String, _ value: String) -> some View {
    let selected = selection == value
    return Button {
      selection = value
    } label: {
      VStack(spacing: 5) {
        Group {
          switch value {
          case "light": MiniWindow(dark: false)
          case "dark": MiniWindow(dark: true)
          default:
            ZStack {
              MiniWindow(dark: false)
              MiniWindow(dark: true).mask(HStack(spacing: 0) { Color.clear; Rectangle() })
            }
          }
        }
        .frame(width: 60, height: 40)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? theme.accent : .clear, lineWidth: 2).padding(-3))
        Text(name).font(theme.caption).foregroundStyle(selected ? theme.text : theme.secondary)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(name) appearance")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

private struct MiniWindow: View {
  var dark: Bool

  var body: some View {
    let window = dark ? Color(white: 0.17) : Color(white: 0.97)
    let side = dark ? Color(white: 0.24) : Color(white: 0.88)
    let line = dark ? Color(white: 0.4) : Color(white: 0.72)
    ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 5).fill(window)
      HStack(spacing: 0) {
        side.frame(width: 18)
        VStack(alignment: .leading, spacing: 4) {
          RoundedRectangle(cornerRadius: 1).fill(line).frame(width: 26, height: 3)
          RoundedRectangle(cornerRadius: 1).fill(line).frame(width: 18, height: 3)
          RoundedRectangle(cornerRadius: 1).fill(line).frame(width: 22, height: 3)
        }
        .padding(.top, 12).padding(.leading, 5)
        Spacer(minLength: 0)
      }
      .clipShape(RoundedRectangle(cornerRadius: 5))
      HStack(spacing: 2) {
        Circle().fill(Color(red: 1, green: 0.37, blue: 0.34))
        Circle().fill(Color(red: 1, green: 0.74, blue: 0.18))
        Circle().fill(Color(red: 0.16, green: 0.79, blue: 0.25))
      }
      .frame(width: 14, height: 4).padding(4)
    }
    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(.black.opacity(0.18), lineWidth: 0.5))
  }
}

// A row of accent colours, the selected one with a white centre and its name underneath.
struct AccentRow: View {
  @Binding var selection: Accent
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(spacing: 5) {
      HStack(spacing: 0) {
        ForEach(Accent.allCases) { accent in
          if accent != Accent.allCases.first { Spacer(minLength: 2) }
          Button {
            selection = accent
          } label: {
            Circle().fill(accent.color).frame(width: 17, height: 17)
              .overlay(Circle().strokeBorder(.black.opacity(0.15), lineWidth: 0.5))
              .overlay { if selection == accent { Circle().fill(.white).frame(width: 6, height: 6) } }
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(accent.name) accent")
          .accessibilityAddTraits(selection == accent ? .isSelected : [])
        }
      }
      Text(selection.name).font(theme.caption).foregroundStyle(theme.secondary)
    }
    .padding(.vertical, 8)
    .control("Accent", choice: $selection, from: Array(Accent.allCases))
  }
}

// A colour row: the label, and a swatch that opens a palette in place, with a hex box and the
// system colour picker. (SwiftUI's ColorPicker can't bring the colour window forward from the
// drawer, which never activates Margin on its own.)
struct ColorRow: View {
  var label: String
  @Binding var color: Color
  var last = false
  @State private var open = false
  @State private var hex = ""
  @Environment(\.theme) private var theme

  private static let palette: [String] = [
    "FFFFFF", "D1D1D6", "8E8E93", "636366", "3A3A3C", "000000",
    "FF3B30", "FF9500", "FFCC00", "34C759", "00C7BE", "30B0C7",
    "32ADE6", "007AFF", "5856D6", "AF52DE", "FF2D55", "A2845E",
    "B3261E", "B26A00", "A68A00", "248A3D", "0A7E73", "0040DD",
    "FFD6D6", "FFE8CC", "FFF5CC", "D4F5DC", "D6EAFF", "EBDDFB",
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text(label)
        Spacer(minLength: 6)
        Button {
          open.toggle()
          hex = color.hex
        } label: {
          RoundedRectangle(cornerRadius: 5).fill(color).frame(width: 36, height: 18)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(theme.border, lineWidth: 1))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(open ? theme.accent : .clear, lineWidth: 2).padding(-3))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) colour")
        .control("colour:\(label)") {
          open.toggle()
          hex = color.hex
        }
      }
      .padding(.vertical, 6)
      if open {
        VStack(alignment: .leading, spacing: 8) {
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
            ForEach(Self.palette, id: \.self) { value in
              Button {
                color = Color(hex: value) ?? color
                hex = value
              } label: {
                Circle().fill(Color(hex: value) ?? .clear).frame(width: 18, height: 18)
                  .overlay(Circle().strokeBorder(.black.opacity(0.15), lineWidth: 0.5))
                  .overlay(Circle().strokeBorder(theme.accent, lineWidth: color.hex == value ? 2 : 0).padding(-3))
              }
              .buttonStyle(.plain)
              .accessibilityLabel("#\(value)")
            }
          }
          HStack(spacing: 6) {
            Text("#").foregroundStyle(theme.secondary)
            TextField("RRGGBB", text: $hex)
              .textFieldStyle(.roundedBorder)
              .frame(width: 76)
              .onSubmit { if let c = Color(hex: hex.uppercased()) { color = c } }
            Spacer()
            Button("Other…") { ColorPanel.shared.open(color) { color = $0 } }.buttonStyle(.link)
          }
        }
        .padding(.bottom, 8)
      }
      if !last { Divider().overlay(theme.divider) }
    }
  }
}

// The system colour window, brought forward from the drawer. Margin is activated first,
// since the drawer never activates it on its own.
@MainActor
final class ColorPanel: NSObject {
  static let shared = ColorPanel()
  private var onChange: ((Color) -> Void)?

  var isOpen: Bool { NSColorPanel.shared.isVisible }

  func open(_ color: Color, onChange: @escaping (Color) -> Void) {
    self.onChange = onChange
    let panel = NSColorPanel.shared
    panel.showsAlpha = false
    panel.isContinuous = true
    panel.color = NSColor(color)
    panel.setTarget(self)
    panel.setAction(#selector(changed(_:)))
    // Above the drawer, which floats.
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
    NSApp.activate()
    panel.makeKeyAndOrderFront(nil)
  }

  @objc private func changed(_ sender: NSColorPanel) {
    onChange?(Color(nsColor: sender.color))
  }
}
