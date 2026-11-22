import SwiftUI

// How Margin works, in four short pages: shown after the welcome on first launch, and from
// Settings any time.
struct GuideView: View {
  var onDone: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var page = 0

  private let pages = 4

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("How Margin works").font(theme.caption).foregroundStyle(theme.tertiary)
        Spacer()
        Button("Skip", action: onDone).buttonStyle(.plain).font(theme.caption).foregroundStyle(theme.secondary)
      }
      illustration
        .frame(maxWidth: .infinity, minHeight: 130)
        .background(RoundedRectangle(cornerRadius: theme.controlRadius + 2).fill(theme.surface))
      Text(title).font(theme.title)
      Text(text).font(theme.small).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      Spacer()
      HStack(spacing: 6) {
        ForEach(0..<pages, id: \.self) { index in
          Circle().fill(index == page ? theme.text : theme.border).frame(width: 6, height: 6)
        }
        Spacer()
        if page > 0 {
          Button("Back") { page -= 1 }.buttonStyle(.plain).foregroundStyle(theme.secondary)
        }
        Button(page == pages - 1 ? "Got it" : "Next") {
          if page == pages - 1 { onDone() } else { page += 1 }
        }
        .buttonStyle(.plain).fontWeight(.semibold).foregroundStyle(theme.onAccent)
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: theme.controlRadius).fill(theme.accent))
      }
    }
    .padding(.horizontal, 20).padding(.vertical, 22)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var title: LocalizedStringResource {
    switch page {
    case 0: "The strip"
    case 1: "Opening it"
    case 2: "Moving it"
    default: "What friends see"
    }
  }

  private var text: LocalizedStringResource {
    switch page {
    case 0:
      "A dot for each friend who’s coding right now: solid when they’re in a tool, half-filled when they’re idle. The number underneath is your unread messages, and the strip glows once when one arrives."
    case 1:
      "\(openWays) Click a friend to chat. With the keyboard: ↑ and ↓ pick a friend or a setting, Return opens or presses it, ← and → change a choice, Tab or ⌘1–3 switch tabs, and Esc steps back. In a chat, ↑ picks a message and ⌘C copies it. It never takes focus from your work unless you open it with ⌥M or start typing."
    case 2:
      "Drag the strip up or down the edge, or across the screen to the other side. It stays where you leave it, on every Space and over full-screen apps."
    default:
      "The tool you’re in, the model, how long you’ve been at it, your token total, and the repo when it’s public. Never your code, prompts, files or branches. Change any of it in Settings, or go invisible."
    }
  }

  // "Hover over the strip, click it or press ⌥M to open the drawer.", in the language's own list style.
  private var openWays: String {
    var ways: [String] = []
    if model.prefs.openOnHover { ways.append(String(localized: "hover over the strip")) }
    if model.prefs.openOnClick { ways.append(String(localized: "click it")) }
    if model.prefs.openOnHotkey { ways.append(String(localized: "press ⌥M")) }
    guard !ways.isEmpty else { return String(localized: "Turn on a way to open it in Settings.") }
    let sentence = String(localized: "\(ways.formatted(.list(type: .or))) to open the drawer.")
    return sentence.prefix(1).uppercased() + sentence.dropFirst()
  }

  @ViewBuilder private var illustration: some View {
    switch page {
    case 0:
      HStack(spacing: 14) {
        VStack(alignment: .trailing, spacing: 11) {
          Text("in a tool").font(theme.caption).foregroundStyle(theme.secondary)
          Text("idle").font(theme.caption).foregroundStyle(theme.secondary)
          Text("unread").font(theme.caption).foregroundStyle(theme.secondary)
        }
        miniStrip(dots: [true, true, false], unread: 2, glow: false)
      }
    case 1:
      HStack(spacing: 0) {
        Spacer()
        miniPanel
        miniStrip(dots: [true, true, false], unread: 0, glow: false)
      }
      .padding(.trailing, 0)
    case 2:
      HStack {
        Spacer()
        VStack(spacing: 6) {
          Image(systemName: "arrow.up").font(theme.font(11)).foregroundStyle(theme.tertiary)
          miniStrip(dots: [true, true], unread: 0, glow: false)
          Image(systemName: "arrow.down").font(theme.font(11)).foregroundStyle(theme.tertiary)
        }
      }
    default:
      VStack(alignment: .leading, spacing: 6) {
        Label { Text(verbatim: "Claude Code · maya/tidepool") } icon: { Image(systemName: "checkmark") }.font(theme.caption)
        Label { Text(verbatim: "claude-opus-5-5 · 3h 4m") } icon: { Image(systemName: "checkmark") }.font(theme.caption)
        Label("48.1M tokens", systemImage: "checkmark").font(theme.caption)
        Label("code, prompts, files", systemImage: "xmark").font(theme.caption).foregroundStyle(theme.tertiary)
      }
      .foregroundStyle(theme.text)
    }
  }

  private func miniStrip(dots: [Bool], unread: Int, glow: Bool) -> some View {
    VStack(spacing: 7) {
      ForEach(Array(dots.enumerated()), id: \.offset) { _, active in
        PresenceDot(active ? .tool : .idle, size: 6)
      }
      if unread > 0 { Text("\(unread)").font(theme.font(8, bold: true)).foregroundStyle(theme.unread) }
    }
    .padding(.vertical, 9)
    .frame(width: 12)
    .themeSurface(UnevenRoundedRectangle(topLeadingRadius: theme.stripRadius, bottomLeadingRadius: theme.stripRadius), theme)
  }

  private var miniPanel: some View {
    VStack(alignment: .leading, spacing: 5) {
      RoundedRectangle(cornerRadius: 1).fill(theme.text).frame(width: 44, height: 3)
      ForEach(0..<3, id: \.self) { row in
        HStack(spacing: 4) {
          Circle().fill(row == 2 ? theme.idle : theme.inTool).frame(width: 4, height: 4)
          RoundedRectangle(cornerRadius: 1).fill(theme.secondary).frame(width: row == 1 ? 34 : 48, height: 2.5)
        }
      }
    }
    .padding(10)
    .themeSurface(UnevenRoundedRectangle(topLeadingRadius: 8, bottomLeadingRadius: 8), theme)
  }
}
