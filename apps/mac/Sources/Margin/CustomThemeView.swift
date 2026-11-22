import AppKit
import SwiftUI

// The custom theme editor. Every change applies at once, so the drawer around it is the
// preview; anything not changed keeps following the theme it started from.
struct CustomThemeView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  private static let typefaces = ["system", "rounded", "serif", "monospaced"]
  private static let families = NSFontManager.shared.availableFontFamilies.sorted()

  var body: some View {
    @Bindable var prefs = model.prefs
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Button {
          model.showThemeEditor = false
        } label: {
          Image(systemName: "chevron.left").font(theme.font(13, bold: true))
            .foregroundStyle(theme.secondary).frame(width: 22, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back")
        Text("Custom theme").font(theme.bodyBold)
        Spacer()
        Button("Reset") { prefs.customTheme = CustomTheme(base: prefs.customTheme.base) }.buttonStyle(.link)
      }
      .padding(.horizontal, 10).padding(.vertical, 12)
      Divider().overlay(theme.divider)

      ScrollView {
        VStack(alignment: .leading, spacing: 4) {
          sample

          SettingsGroup("Start from") {
            SettingsRow(label: "Theme", last: true) {
              Picker("Start from", selection: $prefs.customTheme.base) {
                ForEach(ThemeStyle.allCases.filter { $0 != .custom }) { style in Text(style.name).tag(style.rawValue) }
              }
              .labelsHidden().fixedSize()
              .control(
                "Start from", choice: $prefs.customTheme.base,
                from: ThemeStyle.allCases.filter { $0 != .custom }.map(\.rawValue))
            }
          }

          SettingsGroup("Colours") {
            colour("Background", \.background, theme.background)
            colour("Panels", \.surface, theme.surface)
            colour("Text", \.text, theme.text)
            colour("Borders", \.border, theme.border)
            colour("Accent", \.accent, theme.accent, last: true)
          }

          SettingsGroup("Text") {
            SettingsRow(label: "Typeface") {
              Picker("Typeface", selection: typeface) {
                Text("System").tag("system")
                Text("Rounded").tag("rounded")
                Text("Serif").tag("serif")
                Text("Monospaced").tag("monospaced")
                Divider()
                ForEach(Self.families, id: \.self) { family in Text(family).tag(family) }
              }
              .labelsHidden().frame(maxWidth: 130)
              .control("Typeface", choice: typeface, from: Self.typefaces)
            }
            SettingsRow(label: "Weight") {
              Picker("Weight", selection: weight) {
                Text(LocalizedStringResource("Light weight", defaultValue: "Light", comment: "Font weight")).tag("light")
                Text("Regular").tag("regular")
                Text("Medium").tag("medium")
              }
              .labelsHidden().fixedSize()
              .control("Weight", choice: weight, from: ["light", "regular", "medium"])
            }
            slider("Size", \.textScale, theme.textScale, 0.85...1.25, step: 0.05, percent: true, last: true)
          }

          SettingsGroup("Shapes") {
            slider("Roundness", \.roundness, roundness, 0...1, step: 0.1, ends: ("Square", "Round"))
            SettingsRow(label: "Frosted glass", last: true) {
              Toggle(
                "Frosted glass",
                isOn: Binding(get: { theme.glass != nil }, set: { model.prefs.customTheme.glass = $0 })
              )
              .toggleStyle(.switch).labelsHidden()
              .control("Frosted glass") { model.prefs.customTheme.glass = theme.glass == nil }
            }
          }

          SettingsGroup("Dots") {
            SettingsRow(label: "Shape") {
              Picker("Shape", selection: dotShape) {
                ForEach(DotShape.allCases) { shape in Text(shape.name).tag(shape) }
              }
              .labelsHidden().fixedSize()
              .control("Dot shape", choice: dotShape, from: DotShape.allCases)
            }
            slider("Size", \.dotScale, Double(theme.rowDot / 7), 0.8...1.8, step: 0.1, percent: true)
            colour("In a tool", \.inTool, theme.inTool)
            colour("Idle", \.idle, theme.idle)
            colour("Unread", \.unread, theme.unread, last: true)
          }
          Text("Idle dots stay half-filled whatever their colour, so they never depend on colour alone.")
            .font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
        }
        .controlSize(.small)
        .font(theme.font(12))
        .padding(16)
      }
      .edgeFade(10)
    }
  }

  // The dots and badge as they'll look on the strip and in rows.
  private var sample: some View {
    HStack(spacing: 10) {
      PresenceDot(.tool, size: theme.rowDot)
      PresenceDot(.idle, size: theme.rowDot)
      PresenceDot(.offline, size: theme.rowDot)
      Text(verbatim: "2").font(theme.font(10, bold: true)).foregroundStyle(theme.onUnread)
        .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 16)
        .background(Capsule().fill(theme.unread))
      Spacer()
      Text(verbatim: "Aa").font(theme.title)
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: theme.nested(16)).fill(theme.surface))
  }

  private var roundness: Double { Double((theme.radius - 2) / 20).clamped(to: 0...1) }

  private var typeface: Binding<String> {
    Binding(
      get: {
        if let name = theme.fontName { return name }
        switch theme.design {
        case .rounded: return "rounded"
        case .serif: return "serif"
        case .monospaced: return "monospaced"
        default: return "system"
        }
      },
      set: { model.prefs.customTheme.typeface = $0 })
  }

  private var weight: Binding<String> {
    Binding(
      get: { theme.weight == .light ? "light" : theme.weight == .medium ? "medium" : "regular" },
      set: { model.prefs.customTheme.weight = $0 })
  }

  private var dotShape: Binding<DotShape> {
    Binding(get: { theme.dotShape }, set: { model.prefs.customTheme.dotShape = $0 })
  }

  private func colour(
    _ title: LocalizedStringResource, _ key: WritableKeyPath<CustomTheme, String?>, _ current: Color, last: Bool = false
  ) -> some View {
    ColorRow(
      label: title,
      color: Binding(
        get: { Color(hex: model.prefs.customTheme[keyPath: key]) ?? current },
        set: { model.prefs.customTheme[keyPath: key] = $0.hex }),
      last: last)
  }

  private func slider(
    _ title: LocalizedStringResource, _ key: WritableKeyPath<CustomTheme, Double?>, _ current: Double,
    _ range: ClosedRange<Double>, step: Double, percent: Bool = false,
    ends: (LocalizedStringResource, LocalizedStringResource)? = nil, last: Bool = false
  ) -> some View {
    let value = Binding(
      get: { model.prefs.customTheme[keyPath: key] ?? current },
      set: { model.prefs.customTheme[keyPath: key] = $0 })
    return VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(title)
        Spacer()
        if percent { Text("\(Int((value.wrappedValue * 100).rounded()))%").foregroundStyle(theme.secondary) }
      }
      .padding(.top, 6)
      Slider(value: value, in: range, step: step) {
        Text(title)
      } minimumValueLabel: {
        if let ends { Text(ends.0).font(theme.caption) }
      } maximumValueLabel: {
        if let ends { Text(ends.1).font(theme.caption) }
      }
      .labelsHidden()
      .padding(.bottom, 6)
      if !last { Divider().overlay(theme.divider) }
    }
    .control(String(localized: title) + String(describing: key)) {} adjust: { delta in
      value.wrappedValue = (value.wrappedValue + Double(delta) * step).clamped(to: range)
    }
  }
}

extension Comparable {
  func clamped(to range: ClosedRange<Self>) -> Self { min(max(self, range.lowerBound), range.upperBound) }
}
