import SwiftUI

struct PanelView: View {
  var onClose: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(spacing: 0) {
      if model.misplaced {
        VStack(alignment: .leading, spacing: 6) {
          Text("Move Margin to Applications").font(theme.bodyBold)
          Text("It’s running from your Downloads folder, so it can’t update itself. Quit it, drag Margin into Applications, and open it from there.")
            .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
          Button("Quit Margin") { NSApp.terminate(nil) }.buttonStyle(.link)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
      }
      if !model.daemonUp {
        StateView(
          title: "Margin isn’t running in the background",
          text: "Your friends and messages will appear once it’s back. It restarts automatically.")
      } else if model.me?.connection == "update-required" {
        StateView(title: "Margin needs an update", text: "This version can’t talk to the server any more.")
        if model.updates.enabled {
          Button("Update now") { model.updates.checkNow() }.buttonStyle(.link).padding(.horizontal, 20)
        }
      } else if model.needsSetup {
        SetupView()
      } else if let handle = model.chatWith {
        ChatView(handle: handle)
      } else {
        header
        Divider().overlay(theme.divider)
        if model.me?.connection == "offline" || model.me?.connection == "connecting" {
          Text("Offline · reconnecting").font(theme.caption).foregroundStyle(theme.secondary)
            .frame(maxWidth: .infinity).padding(.vertical, 6).background(theme.surface)
        }
        switch model.tab {
        case .friends: FriendsView()
        case .add: AddView()
        case .settings: SettingsView(onQuit: { NSApp.terminate(nil) })
        }
      }
    }
    .frame(width: theme.panelWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    .font(theme.body)
    .foregroundStyle(theme.text)
    .themeSurface(shape, theme)
    .clipShape(shape)
  }

  private var shape: UnevenRoundedRectangle {
    model.prefs.edge == "left"
      ? UnevenRoundedRectangle(bottomTrailingRadius: theme.radius, topTrailingRadius: theme.radius)
      : UnevenRoundedRectangle(topLeadingRadius: theme.radius, bottomLeadingRadius: theme.radius)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("\(Format.tokens(model.me?.tokens)) tokens").font(theme.bodyBold)
        Text("all time").font(theme.caption).foregroundStyle(theme.tertiary)
      }
      HStack(spacing: 16) {
        tab("Friends", .friends)
        tab(model.requests.incoming.isEmpty ? "Add" : "Add (\(model.requests.incoming.count))", .add)
        Spacer()
        Button {
          model.tab = .settings
        } label: {
          Image(systemName: "gearshape").font(theme.font(13))
            .foregroundStyle(model.tab == .settings ? theme.text : theme.secondary)
            .padding(.bottom, 8)
            .overlay(alignment: .bottom) { underline(model.tab == .settings) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Settings")
      }
      .font(theme.font(12))
    }
    .padding(.horizontal, 16)
    .padding(.top, 14)
  }

  private func tab(_ title: String, _ value: Tab) -> some View {
    Button {
      model.tab = value
    } label: {
      Text(title)
        .fontWeight(model.tab == value ? .semibold : .regular)
        .foregroundStyle(model.tab == value ? theme.text : theme.secondary)
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) { underline(model.tab == value) }
    }
    .buttonStyle(.plain)
  }

  private func underline(_ selected: Bool) -> some View {
    Rectangle().fill(selected ? theme.text : .clear).frame(height: 2)
  }
}

struct StateView: View {
  var title: String
  var text: String
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Circle().strokeBorder(theme.offline, lineWidth: 1).frame(width: 9, height: 9)
      Text(title).font(theme.title)
      Text(text).font(theme.small).foregroundStyle(theme.secondary)
      Spacer()
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SectionLabel: View {
  var text: String
  @Environment(\.theme) private var theme
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text.uppercased()).font(theme.section).kerning(0.6).foregroundStyle(theme.tertiary)
  }
}
