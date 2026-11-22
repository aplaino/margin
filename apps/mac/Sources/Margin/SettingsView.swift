import AppKit
import SwiftUI

struct SettingsView: View {
  var onQuit: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var newRepo = ""
  @State private var newRepoMode = "hidden"
  @State private var opensAtLogin = Launcher.opensAtLogin
  @FocusState private var repoFocused: Bool

  var body: some View {
    @Bindable var prefs = model.prefs
    ScrollViewReader { proxy in
    ScrollView {
      VStack(alignment: .leading, spacing: 7) {
        SectionLabel("Open Margin with").padding(.top, 4)
        HStack(spacing: 12) {
          Check("Hover", isOn: $prefs.openOnHover)
          Check("Click", isOn: $prefs.openOnClick)
          Check("⌥M", isOn: $prefs.openOnHotkey)
        }

        SectionLabel("Position").padding(.top, 6)
        Picker("Show Margin", selection: $prefs.menuBar) {
          Text("Screen edge").tag(false)
          Text("Menu bar").tag(true)
        }
        .pickerStyle(.segmented).labelsHidden()
        .control("Show Margin", choice: $prefs.menuBar, from: [false, true])
        if prefs.menuBar {
          Text("Beside the notch, or at the right of the menu bar. ⌘-drag it to move it.")
            .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
          if model.menuBarHidden {
            Text("The menu bar is full, so macOS has hidden it under the notch; the strip is at the screen edge until there’s room.")
              .font(theme.font(10.5)).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
          }
        } else {
          Text("Drag the strip along either edge to move it, or across the screen to switch sides.")
            .font(theme.caption).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
          if prefs.position != nil || prefs.edge != "right" {
            Button("Reset position") { prefs.resetPosition() }.buttonStyle(.link)
              .control("Reset position") { prefs.resetPosition() }
          } else if Prefs.dockEdge == prefs.edge {
            Text("Near the top for now, because your Dock is on the \(prefs.edge).")
              .font(theme.font(10.5)).foregroundStyle(theme.tertiary)
          }
          Check("Fade the strip when nobody’s online", isOn: $prefs.fadeWhenQuiet)
        }

        SectionLabel("Theme").padding(.top, 6)
        Picker("Appearance", selection: $prefs.appearance) {
          Text("System").tag("system")
          Text("Light").tag("light")
          Text("Dark").tag("dark")
        }
        .pickerStyle(.segmented).labelsHidden()
        .control("Appearance", choice: $prefs.appearance, from: ["system", "light", "dark"])
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
          ForEach(ThemeStyle.allCases) { style in
            ThemeTile(style: style, selected: prefs.style == style) { prefs.style = style }
          }
        }
        .control("Theme", choice: $prefs.style, from: Array(ThemeStyle.allCases))
        .padding(.vertical, 4)
        HStack(spacing: 8) {
          Text("Accent")
          Spacer()
          ForEach(Accent.allCases) { accent in
            Button {
              prefs.accent = accent
            } label: {
              Circle().fill(accent.color).frame(width: 16, height: 16)
                .overlay(Circle().strokeBorder(theme.text, lineWidth: prefs.accent == accent ? 2 : 0))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(accent.rawValue.capitalized) accent")
          }
        }
        .control("Accent", choice: $prefs.accent, from: Array(Accent.allCases))

        SectionLabel("Connected tools").padding(.top, 6)
        ToolToggles()

        if let settings = model.settings {
          privacy(settings)
        }

        SectionLabel("General").padding(.top, 6)
        Check(
          "Open Margin at login",
          isOn: Binding(get: { opensAtLogin }, set: { on in Launcher.setOpensAtLogin(on); opensAtLogin = Launcher.opensAtLogin }))

        if model.updates.enabled {
          HStack {
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
              .foregroundStyle(theme.secondary)
            Spacer()
            Button("Check for updates") { model.updates.checkNow() }.buttonStyle(.link)
              .control("Check for updates") { model.updates.checkNow() }
          }
        }

        Picker("Crash reports", selection: $prefs.crashReports) {
          Text("Ask after a crash").tag("ask")
          Text("Always send").tag("always")
          Text("Never send").tag("never")
        }
        .control("Crash reports", choice: $prefs.crashReports, from: ["ask", "always", "never"])
        Text("A report has the app and macOS versions, what went wrong and recent background log lines, with paths, names, repos and messages removed.")
          .font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
        if model.reports.count > 0 {
          HStack(spacing: 12) {
            Text(model.reports.count == 1 ? "1 report waiting" : "\(model.reports.count) reports waiting")
              .foregroundStyle(theme.secondary)
            Spacer()
            Button("Send") { model.request("reports.send") }.buttonStyle(.link)
              .control("Send reports") { model.request("reports.send") }
            Button("Discard") { model.request("reports.discard") }.buttonStyle(.link)
              .control("Discard reports") { model.request("reports.discard") }
          }
        }

        SectionLabel("Notifications").padding(.top, 6)
        Picker("New messages", selection: $prefs.alert) {
          Text("Peek with a preview").tag("preview")
          Text("Peek with the name").tag("name")
          Text("Glow only").tag("glow")
        }
        .labelsHidden()
        .control("New messages", choice: $prefs.alert, from: ["preview", "name", "glow"])
        if prefs.alert == "preview" {
          Text("The first words show beside the strip, where anyone looking at your screen can see them.")
            .font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
        }
        Check("macOS notifications", isOn: Binding(get: { prefs.notifications }, set: { model.setNotifications($0) }))

        SectionLabel("Account").padding(.top, 6)
        HStack {
          Text("@\(model.me?.handle ?? "")")
          Spacer()
          Button("Sign out") { model.request("logout") }.buttonStyle(.link)
            .control("Sign out") { model.request("logout") }
        }
        HStack(spacing: 12) {
          Button("Export data") { model.request("account.export") }.buttonStyle(.link)
            .control("Export data") { model.request("account.export") }
          Button("Delete account", action: confirmDelete).buttonStyle(.link).foregroundStyle(theme.danger)
            .control("Delete account", press: confirmDelete)
        }
        Button("How Margin works") { model.showGuide = true }.buttonStyle(.link)
          .control("How Margin works") { model.showGuide = true }
        Button("Quit Margin", action: onQuit).buttonStyle(.plain).foregroundStyle(theme.secondary).padding(.top, 4)
          .control("Quit Margin", press: onQuit)
      }
      .toggleStyle(.checkbox)
      .controlSize(.small)
      .font(theme.font(12))
      .padding(.horizontal, 16).padding(.vertical, 10)
    }
    .onChange(of: model.cursor) {
      if let cursor = model.cursor { proxy.scrollTo(cursor) }
    }
    .onAppear { if model.signedIn { model.request("blocks") } }
    }
  }

  @ViewBuilder private func privacy(_ settings: PrivacySettings) -> some View {
    SectionLabel("Privacy").padding(.top, 6)
    Check("Invisible", isOn: bind(\.invisible))
    Check(
      "Show me in Find friends",
      isOn: Binding(
        get: { model.settings?.findable ?? true },
        set: { on in model.updateSettings { $0.findable = on } }))
    Text("Friends see:").foregroundStyle(theme.secondary)
    FlowRow {
      Check("tool", isOn: bind(\.share.tool))
      Check("model", isOn: bind(\.share.model))
      Check("repo", isOn: bind(\.share.repo))
      Check("time", isOn: bind(\.share.time))
      Check("tokens", isOn: bind(\.share.tokens))
    }
    Check(
      "Close friends only",
      isOn: Binding(
        get: { model.settings?.audience == "close" },
        set: { on in model.updateSettings { $0.audience = on ? "close" : "everyone" } }))
    if settings.audience == "close" {
      Text("Everyone else sees only online or idle.").font(theme.caption).foregroundStyle(theme.tertiary)
      ForEach(model.friends) { friend in
        Check(
          friend.displayName,
          isOn: Binding(
            get: { model.settings?.closeFriends.contains(friend.handle) == true },
            set: { on in
              model.updateSettings { s in
                s.closeFriends.removeAll { $0 == friend.handle }
                if on { s.closeFriends.append(friend.handle) }
              }
            }),
          id: "close:\(friend.handle)"
        )
        .padding(.leading, 18)
      }
    }
    if !model.blocked.isEmpty {
      Text("Blocked").foregroundStyle(theme.secondary).padding(.top, 2)
      ForEach(model.blocked, id: \.self) { handle in
        HStack {
          Text(handle).lineLimit(1)
          Spacer()
          Button("Unblock") { model.request("unblock", ["handle": handle]) }.buttonStyle(.link)
            .control("unblock:\(handle)") { model.request("unblock", ["handle": handle]) }
        }
      }
    }
    Text("Repo overrides").foregroundStyle(theme.secondary).padding(.top, 2)
    ForEach(settings.repos.keys.sorted(), id: \.self) { repo in
      HStack {
        Text(repo).font(theme.mono).lineLimit(1)
        Spacer()
        Text(settings.repos[repo] == "hidden" ? "hidden" : "private").font(theme.caption).foregroundStyle(theme.tertiary)
        Button {
          model.updateSettings { $0.repos[repo] = nil }
        } label: {
          Image(systemName: "xmark").font(theme.font(9, bold: true))
        }
        .buttonStyle(.plain).accessibilityLabel("Remove override for \(repo)")
        .control("repo:\(repo)") { model.updateSettings { $0.repos[repo] = nil } }
      }
    }
    HStack(spacing: 6) {
      TextField("owner/repo", text: $newRepo).textFieldStyle(.roundedBorder)
        .focused($repoFocused)
        .control("New repo") { repoFocused = true }
      Picker("", selection: $newRepoMode) {
        Text("Hide").tag("hidden")
        Text("Private").tag("private")
      }
      .labelsHidden().frame(width: 76)
      .control("New repo mode", choice: $newRepoMode, from: ["hidden", "private"])
      Button("Add", action: addRepo)
        .control("Add repo", press: addRepo)
    }
  }

  private func addRepo() {
    let repo = newRepo.trimmingCharacters(in: .whitespaces)
    guard repo.range(of: #"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$"#, options: .regularExpression) != nil else { return }
    model.updateSettings { $0.repos[repo] = newRepoMode }
    newRepo = ""
  }

  private func bind(_ path: WritableKeyPath<PrivacySettings, Bool>) -> Binding<Bool> {
    Binding(
      get: { model.settings?[keyPath: path] ?? false },
      set: { value in model.updateSettings { $0[keyPath: path] = value } })
  }

  private func confirmDelete() {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = "Delete your Margin account?"
    alert.informativeText =
      "Your friends, keys and anything waiting on the server are deleted. Chat history on this Mac stays until you remove Margin."
    alert.addButton(withTitle: "Delete")
    alert.addButton(withTitle: "Cancel")
    alert.buttons.first?.hasDestructiveAction = true
    if alert.runModal() == .alertFirstButtonReturn { model.request("account.delete") }
  }
}

// Lays toggles out in rows that wrap.
struct FlowRow: Layout {
  var spacing: CGFloat = 10

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? 228
    var x: CGFloat = 0
    var y: CGFloat = 0
    var row: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        x = 0
        y += row + 4
        row = 0
      }
      x += size.width + spacing
      row = max(row, size.height)
    }
    return CGSize(width: width, height: y + row)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var row: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > bounds.minX, x + size.width > bounds.maxX {
        x = bounds.minX
        y += row + 4
        row = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      row = max(row, size.height)
    }
  }
}

// A miniature drawer drawn in a theme, in the current light or dark appearance.
struct ThemeTile: View {
  var style: ThemeStyle
  var selected: Bool
  var choose: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var current
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let theme = style.theme(dark: scheme == .dark, accent: model.prefs.accent.color)
    Button(action: choose) {
      VStack(spacing: 5) {
        VStack(alignment: .leading, spacing: 4) {
          RoundedRectangle(cornerRadius: 1).fill(theme.text).frame(width: 28, height: 3)
          ForEach(0..<3, id: \.self) { row in
            HStack(spacing: 4) {
              Circle().fill(row == 2 ? theme.idle : theme.inTool).frame(width: 4, height: 4)
              RoundedRectangle(cornerRadius: 1).fill(theme.secondary).frame(width: row == 1 ? 22 : 30, height: 2.5)
            }
          }
          RoundedRectangle(cornerRadius: 1).fill(theme.accent).frame(width: 18, height: 3)
        }
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: 50, alignment: .topLeading)
        .themeSurface(RoundedRectangle(cornerRadius: min(theme.radius, 8)), theme)
        .overlay(
          RoundedRectangle(cornerRadius: min(theme.radius, 8) + 3)
            .strokeBorder(selected ? current.accent : .clear, lineWidth: 2)
            .padding(-3))
        Text(style.name).font(theme.font(10, heading: true)).foregroundStyle(current.text).lineLimit(1)
          .minimumScaleFactor(0.8)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(style.name) theme")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
