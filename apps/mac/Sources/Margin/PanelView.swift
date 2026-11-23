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
          Text("It’s running from outside Applications, so it can’t update itself and can’t connect your tools.")
            .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
          Button("Move to Applications") {
            do { try Mover.moveToApplications() } catch { model.moveError = error.localizedDescription }
          }
          .buttonStyle(.link)
          if let error = model.moveError {
            Text(error).font(theme.caption).foregroundStyle(theme.danger).fixedSize(horizontal: false, vertical: true)
          }
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
      } else if model.showGuide {
        GuideView(onDone: { model.showGuide = false })
      } else if model.showThemeEditor {
        CustomThemeView()
      } else if let handle = model.chatWith {
        ChatView(handle: handle)
      } else if let handle = model.profileOf {
        ProfileView(handle: handle)
      } else {
        header
        Divider().overlay(theme.divider)
        if model.me?.connection == "offline" || model.me?.connection == "connecting" {
          Text("Offline · reconnecting").font(theme.caption).foregroundStyle(theme.secondary)
            .frame(maxWidth: .infinity).padding(.vertical, 6).background(theme.surface)
        }
        if model.askAboutErrors, model.prefs.crashReports == "ask" { WaitingErrorsView() }
        Group {
          switch model.tab {
          case .friends: FriendsView()
          case .chats: ChatsView()
          case .add: AddView()
          case .settings: SettingsView(onQuit: { NSApp.terminate(nil) })
          }
        }
        .onPreferenceChange(Controls.self) { controls in
          MainActor.assumeIsolated { model.controls = controls }
        }
      }
    }
    .frame(width: theme.panelWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    // No scroll bars on any page, even with "Always" in System Settings; the edge fades show
    // there's more.
    .scrollIndicators(.never)
    .font(theme.body)
    .foregroundStyle(theme.text)
    .themeSurface(shape, theme)
    .clipShape(shape)
  }

  private var shape: UnevenRoundedRectangle {
    // Flush with the menu bar above it, or with the screen edge beside it.
    if model.atTop { return UnevenRoundedRectangle(bottomLeadingRadius: theme.radius, bottomTrailingRadius: theme.radius) }
    return model.prefs.edge == "left"
      ? UnevenRoundedRectangle(bottomTrailingRadius: theme.radius, topTrailingRadius: theme.radius)
      : UnevenRoundedRectangle(topLeadingRadius: theme.radius, bottomLeadingRadius: theme.radius)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      // Your all-time total, rolling up as tokens come in.
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        // Your total opens your profile, as friends see it.
        Button {
          if let handle = model.me?.handle { model.openProfile(handle) }
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(model.prefs.tokenTotal(model.me?.tokens)).font(theme.bodyBold).monospacedDigit()
              .lineLimit(1).layoutPriority(1)
              .contentTransition(.numericText(value: model.me?.tokens ?? 0))
              .animation(.smooth, value: model.me?.tokens)
            // Another unit or notation can run long, so only the default keeps the label.
            if model.prefs.defaultTokenFormat {
              Text("tokens · all time").font(theme.caption).foregroundStyle(theme.tertiary).lineLimit(1)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Your profile")
        Spacer(minLength: 6)
        Text(model.me?.handle.map { "@\($0)" } ?? "").font(theme.caption).foregroundStyle(theme.secondary)
          .lineLimit(1)
      }
      HStack(spacing: 16) {
        tab("Friends", .friends)
        tab(model.unreadTotal == 0 ? "Chats" : "Chats (\(model.unreadTotal))", .chats)
        tab(model.requests.incoming.isEmpty ? "Add" : "Add (\(model.requests.incoming.count))", .add)
        Spacer()
        Button {
          model.showTab(.settings)
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

  private func tab(_ title: LocalizedStringResource, _ value: Tab) -> some View {
    Button {
      model.showTab(value)
    } label: {
      Text(title)
        .lineLimit(1).minimumScaleFactor(0.8)
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

// Errors Margin got past, asked about with the same choices as after a crash. Show lists
// exactly what would be sent.
struct WaitingErrorsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var showing = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Something went wrong in the background").font(theme.bodyBold)
      Text(
        "Send a report so it can be fixed? It has the app and macOS versions, what went wrong and recent background log lines. Paths, names, repos and messages are removed first; it never includes your code, prompts or chats."
      )
      .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 12) {
        Button("Send Report") { model.answerWaitingErrors(send: true) }
        Button("Don’t Send") { model.answerWaitingErrors(send: false) }
        Spacer()
        Button(showing ? "Hide" : "Show") {
          showing.toggle()
          if showing { model.request("reports.list") }
        }
      }
      .buttonStyle(.link)
      Button("Always send reports") { model.answerWaitingErrors(send: true, always: true) }.buttonStyle(.link)
      if showing, let reports = model.waitingReports {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 10) {
            ForEach(reports.indices, id: \.self) { i in
              let report = reports[i]
              VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: report.what).font(theme.small).fontWeight(.semibold)
                Text(verbatim: "\(report.kind) · \(report.version) · \(report.os)").font(theme.caption)
                  .foregroundStyle(theme.tertiary)
                Text(verbatim: report.detail).font(theme.mono).foregroundStyle(theme.secondary)
              }
            }
          }
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.vertical, 8)
        }
        .frame(maxHeight: 220)
        .edgeFade(8)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(theme.surface)
  }
}

struct StateView: View {
  var title: LocalizedStringResource
  var text: LocalizedStringResource
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      PresenceDot(.offline, size: 9)
      Text(title).font(theme.title)
      Text(text).font(theme.small).foregroundStyle(theme.secondary)
      Spacer()
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SectionLabel: View {
  var text: LocalizedStringResource
  @Environment(\.theme) private var theme
  init(_ text: LocalizedStringResource) { self.text = text }
  var body: some View {
    // textCase follows the language, so Greek capitals drop their accents.
    Text(text).textCase(.uppercase).font(theme.section).kerning(0.6).foregroundStyle(theme.tertiary)
  }
}
