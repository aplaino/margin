import AppKit
import SwiftUI

// The one window Margin opens on its own, on first launch only: a strip at the screen edge or
// a few dots in the menu bar are easy to miss, so this says where Margin lives and lets you
// pick. Getting started (or closing it) opens the drawer right there, where setup carries on.
@MainActor
final class WelcomeWindow: NSObject, NSWindowDelegate {
  private let window: NSWindow
  private let onDone: () -> Void
  private var finished = false

  init(model: AppModel, onDone: @escaping () -> Void) {
    self.onDone = onDone
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 470),
      styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
    super.init()
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.delegate = self
    let close: () -> Void = { [weak window] in window?.close() }
    window.contentView = NSHostingView(rootView: Themed(model: model) { WelcomeView(onStart: close) })
  }

  func show() {
    window.center()
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    guard !finished else { return }
    finished = true
    onDone()
  }
}

struct WelcomeView: View {
  var onStart: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(spacing: 0) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 88, height: 88)
      Text("Welcome to Margin").font(.system(size: 22, weight: .semibold)).padding(.top, 10)
      Text("See what your friends are building, from one spot on your screen.")
        .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true).padding(.top, 6)

      Text("Where should it live?").font(.system(size: 13, weight: .semibold)).padding(.top, 26)
      HStack(spacing: 14) {
        place("Screen edge", "A thin strip on the right edge. Drag it anywhere.", menuBar: false)
        place("Menu bar", "A few dots beside the notch, at the top right.", menuBar: true)
      }
      .padding(.top, 10)
      Text("You can change this any time in Settings.").font(.system(size: 11)).foregroundStyle(.tertiary)
        .padding(.top, 10)

      Spacer(minLength: 18)
      Button(action: onStart) {
        Text("Get started").font(.system(size: 13, weight: .semibold)).frame(width: 180, height: 30)
      }
      .buttonStyle(.borderedProminent)
      .tint(theme.accent)
      .keyboardShortcut(.defaultAction)
    }
    .padding(.horizontal, 32).padding(.top, 38).padding(.bottom, 28)
    .frame(width: 440, height: 470)
  }

  private func place(_ title: String, _ detail: String, menuBar: Bool) -> some View {
    let selected = model.prefs.menuBar == menuBar
    return Button {
      model.prefs.menuBar = menuBar
    } label: {
      VStack(spacing: 8) {
        PlacementPicture(menuBar: menuBar).frame(height: 78)
        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.primary)
        Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(10)
      .frame(width: 172)
      .background(RoundedRectangle(cornerRadius: 12).fill(.quaternary.opacity(0.5)))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? theme.accent : .clear, lineWidth: 2))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

// A miniature screen showing where Margin sits: the strip on the right edge, or dots in the
// menu bar to the right of the notch.
private struct PlacementPicture: View {
  var menuBar: Bool
  @Environment(\.theme) private var theme

  var body: some View {
    ZStack(alignment: .topTrailing) {
      RoundedRectangle(cornerRadius: 6).fill(Color(white: 0.16))
      VStack(spacing: 0) {
        Rectangle().fill(Color(white: 0.24)).frame(height: 10)
        Spacer()
      }
      .clipShape(RoundedRectangle(cornerRadius: 6))
      if menuBar {
        HStack(spacing: 3) {
          Capsule().fill(.black).frame(width: 26, height: 9).padding(.trailing, 6)
          ForEach(0..<3, id: \.self) { _ in Circle().fill(theme.inTool).frame(width: 4, height: 4) }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .offset(x: 14)
        .frame(height: 10)
      } else {
        VStack(spacing: 3) {
          ForEach(0..<3, id: \.self) { _ in Circle().fill(theme.inTool).frame(width: 4, height: 4) }
        }
        .padding(.vertical, 5).frame(width: 7)
        .background(UnevenRoundedRectangle(topLeadingRadius: 3, bottomLeadingRadius: 3).fill(Color(white: 0.32)))
        .frame(maxHeight: .infinity)
      }
    }
    .frame(width: 136)
  }
}
