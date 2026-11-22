import AppKit
import SwiftUI

// Settings the way System Settings organises them: your account at the top, then categories
// with coloured icons, each opening its own page of grouped cards. The drawer is too narrow
// for a sidebar beside a page, so, as on iPhone, the list opens one page at a time.
enum SettingsPage: String, CaseIterable, Identifiable {
  case account, general, appearance, placement, notifications, privacy, tools
  var id: String { rawValue }

  var title: LocalizedStringResource {
    switch self {
    case .account: "Account"
    case .general: "General"
    case .appearance: "Appearance"
    case .placement: "Placement"
    case .notifications: "Notifications"
    case .privacy: "Privacy & Security"
    case .tools: "Connected Tools"
    }
  }

  var symbol: String {
    switch self {
    case .account: "person.crop.circle.fill"
    case .general: "gearshape.fill"
    case .appearance: "circle.lefthalf.filled"
    case .placement: "rectangle.righthalf.inset.filled"
    case .notifications: "bell.badge.fill"
    case .privacy: "hand.raised.fill"
    case .tools: "hammer.fill"
    }
  }

  var tint: Color {
    switch self {
    case .account: .blue
    case .general: .gray
    case .appearance: Color(white: 0.15)
    case .placement: .indigo
    case .notifications: .red
    case .privacy: .blue
    case .tools: .orange
    }
  }
}

struct SettingsView: View {
  var onQuit: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var newRepo = ""
  @State private var newRepoMode = "hidden"
  @State private var opensAtLogin = Launcher.opensAtLogin
  @FocusState private var repoFocused: Bool

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 4) {
          // Pages and the list swap with a soft blur rather than a cut.
          if let page = model.settingsPage {
            VStack(alignment: .leading, spacing: 4) {
              pageHeader(page)
              switch page {
              case .account: account
              case .general: general
              case .appearance: appearance
              case .placement: placement
              case .notifications: notifications
              case .privacy: if let settings = model.settings { privacy(settings) }
              case .tools: tools
              }
            }
            .transition(.blurReplace)
          } else {
            list.transition(.blurReplace)
          }
        }
        .animation(.smooth(duration: 0.22), value: model.settingsPage)
        .controlSize(.small)
        .font(theme.font(12))
        .padding(.horizontal, 14).padding(.vertical, 10)
      }
      .edgeFade(8)
      .onChange(of: model.cursor) {
        if let cursor = model.cursor { proxy.scrollTo(cursor) }
      }
      .onAppear { if model.signedIn { model.request("blocks") } }
    }
  }

  // MARK: the list

  private var list: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        model.settingsPage = .account
      } label: {
        HStack(spacing: 10) {
          let name = model.me?.name ?? model.me?.handle ?? ""
          Text(String(name.prefix(1)).uppercased())
            .font(theme.font(15, bold: true)).foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(Circle().fill(theme.accent))
          VStack(alignment: .leading, spacing: 1) {
            Text(name).font(theme.bodyBold).lineLimit(1)
            Text("@\(model.me?.handle ?? "") · Margin account").font(theme.caption).foregroundStyle(theme.secondary)
              .lineLimit(1)
          }
          Spacer(minLength: 4)
          chevron
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: theme.nested(14)).fill(theme.surface))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .control("page:account") { model.settingsPage = .account }

      SettingsGroup {
        pageRow(.general)
        pageRow(.appearance)
        pageRow(.placement, last: true)
      }
      SettingsGroup {
        pageRow(.notifications)
        pageRow(.privacy)
        pageRow(.tools, last: true)
      }
      SettingsGroup {
        Button(action: onQuit) {
          Text("Quit Margin").foregroundStyle(theme.danger).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .control("Quit Margin", press: onQuit)
      }
    }
  }

  private func pageRow(_ page: SettingsPage, last: Bool = false) -> some View {
    VStack(spacing: 0) {
      Button {
        model.settingsPage = page
      } label: {
        HStack(spacing: 9) {
          Image(systemName: page.symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
            .frame(width: 22, height: 22)
            .background(RoundedRectangle(cornerRadius: 6).fill(page.tint))
          Text(page.title)
          Spacer(minLength: 4)
          chevron
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .control("page:\(page.rawValue)") { model.settingsPage = page }
      if !last { Divider().overlay(theme.divider).padding(.leading, 31) }
    }
  }

  private var chevron: some View {
    Image(systemName: "chevron.right").font(theme.font(10)).foregroundStyle(theme.tertiary)
  }

  private func pageHeader(_ page: SettingsPage) -> some View {
    HStack(spacing: 6) {
      Button {
        model.settingsPage = nil
      } label: {
        Image(systemName: "chevron.left").font(theme.font(13, bold: true)).foregroundStyle(theme.secondary)
          .frame(width: 22, height: 24)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back to Settings")
      Text(page.title).font(theme.title)
      Spacer()
    }
    .padding(.bottom, 2)
  }

  // A row with a switch, the way System Settings shows on and off.
  private func switchRow(_ label: LocalizedStringResource, _ isOn: Binding<Bool>, last: Bool = false) -> some View {
    SettingsRow(label: label, last: last) {
      Toggle(isOn: isOn) { Text(label) }.toggleStyle(.switch).labelsHidden()
    }
    .control(String(localized: label), toggle: isOn)
  }

  private func note(_ text: LocalizedStringResource) -> some View {
    Text(text).font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 2).padding(.top, 2)
  }

  // What you're doing, as close friends see it: the dot, then the tool and repo.
  @ViewBuilder private var status: some View {
    let presence = model.me?.presence
    if model.settings?.invisible == true {
      HStack(spacing: 6) {
        PresenceDot(.offline, size: theme.rowDot)
        Text("Invisible")
      }
    } else if let presence, presence.status != "offline" {
      HStack(spacing: 6) {
        PresenceDot(status: presence.status, size: theme.rowDot)
        Text([Format.what(presence), Format.detail(presence)].filter { !$0.isEmpty }.joined(separator: " · "))
          .lineLimit(1).truncationMode(.tail)
      }
    } else {
      HStack(spacing: 6) {
        PresenceDot(.offline, size: theme.rowDot)
        Text(model.me?.connection == "online" ? "Offline" : "Connecting…")
      }
    }
  }

  // MARK: pages

  private var account: some View {
    let online = model.onlineFriends.count
    return VStack(alignment: .leading, spacing: 4) {
      SettingsGroup {
        SettingsRow(label: model.me?.name.map { .verbatim($0) } ?? "Signed in as") {
          Text(verbatim: "@\(model.me?.handle ?? "")").foregroundStyle(theme.secondary)
        }
        SettingsRow(label: "Status") { status.foregroundStyle(theme.secondary) }
        SettingsRow(label: "Tokens") {
          Text(model.prefs.tokenTotal(model.me?.tokens)).foregroundStyle(theme.secondary).monospacedDigit()
        }
        SettingsRow(label: "Friends", last: true) {
          Group {
            if online > 0 { Text("\(model.friends.count) · \(online) online") } else { Text(verbatim: "\(model.friends.count)") }
          }
          .foregroundStyle(theme.secondary)
        }
      }
      SettingsGroup("Your data") {
        SettingsRow(label: "Export your data") {
          Button("Export…") { model.request("account.export") }.buttonStyle(.link)
            .control("Export data") { model.request("account.export") }
        }
        SettingsRow(label: "Sign out", last: true) {
          Button("Sign Out") { model.request("logout") }.buttonStyle(.link)
            .control("Sign out") { model.request("logout") }
        }
      }
      SettingsGroup {
        Button(action: confirmDelete) {
          Text("Delete Account…").foregroundStyle(theme.danger).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .control("Delete account", press: confirmDelete)
      }
      note("Deleting removes your friends, keys and anything waiting on the server. Chat history on this Mac stays until you remove Margin.")
    }
  }

  private var general: some View {
    @Bindable var prefs = model.prefs
    return VStack(alignment: .leading, spacing: 4) {
      SettingsGroup {
        SettingsRow(label: "Language", last: true) {
          Picker("Language", selection: $prefs.language) {
            Text("System").tag(String?.none)
            Divider()
            // Each in its own language, so people can find theirs.
            ForEach(Prefs.languages, id: \.self) { code in
              Text(verbatim: Locale(identifier: code).localizedString(forIdentifier: code)?.capitalized(with: Locale(identifier: code)) ?? code)
                .tag(String?.some(code))
            }
          }
          .labelsHidden().fixedSize()
          .control("Language", choice: $prefs.language, from: [nil] + Prefs.languages.map { $0 })
        }
      }
      if prefs.language != prefs.launchLanguage {
        HStack(spacing: 6) {
          note("Margin will use this the next time it opens.")
          Button("Relaunch Now") { Mover.relaunch() }.buttonStyle(.link).font(theme.caption)
            .control("Relaunch") { Mover.relaunch() }
        }
      }
      SettingsGroup("Open Margin with") {
        switchRow("Hover", $prefs.openOnHover)
        switchRow("Click", $prefs.openOnClick)
        switchRow("⌥M from anywhere", $prefs.openOnHotkey, last: true)
      }
      SettingsGroup("Token total") {
        SettingsRow(label: "Unit") {
          Picker("Unit", selection: $prefs.tokenUnit) {
            ForEach(TokenUnit.allCases, id: \.self) { Text($0.title).tag($0) }
          }
          .labelsHidden().fixedSize()
          .disabled(prefs.scientificTokens)
          .control("Token unit", choice: $prefs.tokenUnit, from: TokenUnit.allCases)
        }
        switchRow("Scientific notation", $prefs.scientificTokens, last: true)
      }
      note("Shows as \(prefs.tokenTotal(model.me?.tokens)).")
      SettingsGroup {
        switchRow(
          "Open at login",
          Binding(get: { opensAtLogin }, set: { on in Launcher.setOpensAtLogin(on); opensAtLogin = Launcher.opensAtLogin }),
          last: !model.updates.enabled)
        if model.updates.enabled {
          SettingsRow(label: "Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")", last: true) {
            Button("Check for Updates") { model.updates.checkNow() }.buttonStyle(.link)
              .control("Check for updates") { model.updates.checkNow() }
          }
        }
      }
      SettingsGroup("Crash reports") {
        SettingsRow(label: "Send reports", last: model.reports.count == 0) {
          Picker("Crash reports", selection: $prefs.crashReports) {
            Text("Ask after a crash").tag("ask")
            Text("Always").tag("always")
            Text("Never").tag("never")
          }
          .labelsHidden().fixedSize()
          .control("Crash reports", choice: $prefs.crashReports, from: ["ask", "always", "never"])
        }
        if model.reports.count > 0 {
          SettingsRow(label: "\(model.reports.count) waiting", last: true) {
            HStack(spacing: 10) {
              Button("Send") { model.request("reports.send") }.buttonStyle(.link)
                .control("Send reports") { model.request("reports.send") }
              Button("Discard") { model.request("reports.discard") }.buttonStyle(.link)
                .control("Discard reports") { model.request("reports.discard") }
            }
          }
        }
      }
      note("A report has the app and macOS versions, what went wrong and recent background log lines, with paths, names, repos and messages removed.")
      SettingsGroup {
        SettingsRow(label: "How Margin works", last: true) {
          Button("Show") { model.showGuide = true }.buttonStyle(.link)
            .control("How Margin works") { model.showGuide = true }
        }
      }
    }
  }

  private var appearance: some View {
    @Bindable var prefs = model.prefs
    return VStack(alignment: .leading, spacing: 4) {
      SettingsGroup("Appearance") {
        AppearanceTiles(selection: $prefs.appearance)
      }
      SettingsGroup("Theme") {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
          ForEach(ThemeStyle.allCases) { style in
            ThemeTile(style: style, selected: prefs.style == style) {
              prefs.style = style
              if style == .custom { model.showThemeEditor = true }
            }
          }
        }
        .control("Theme", choice: $prefs.style, from: Array(ThemeStyle.allCases))
        .padding(.vertical, 8)
        if prefs.style == .custom {
          Divider().overlay(theme.divider)
          Button("Edit custom theme…") { model.showThemeEditor = true }.buttonStyle(.link)
            .control("Edit custom theme") { model.showThemeEditor = true }
            .padding(.vertical, 6)
        }
      }
      SettingsGroup("Accent colour") {
        AccentRow(selection: $prefs.accent)
      }
    }
  }

  private var placement: some View {
    @Bindable var prefs = model.prefs
    return VStack(alignment: .leading, spacing: 4) {
      SettingsGroup("Show Margin") {
        Picker("Show Margin", selection: $prefs.menuBar) {
          Text("Screen edge").tag(false)
          Text("Menu bar").tag(true)
        }
        .pickerStyle(.segmented).labelsHidden()
        .padding(.vertical, 8)
        .control("Show Margin", choice: $prefs.menuBar, from: [false, true])
      }
      if prefs.menuBar {
        note("Beside the notch, or at the right of the menu bar. ⌘-drag it to move it.")
        if model.menuBarHidden {
          note("The menu bar is full, so macOS has hidden it under the notch; the strip is at the screen edge until there’s room.")
        }
      } else {
        SettingsGroup {
          switchRow("Fade when nobody’s online", $prefs.fadeWhenQuiet, last: !(prefs.position != nil || prefs.edge != "right"))
          if prefs.position != nil || prefs.edge != "right" {
            SettingsRow(label: "Position", last: true) {
              Button("Reset") { prefs.resetPosition() }.buttonStyle(.link)
                .control("Reset position") { prefs.resetPosition() }
            }
          }
        }
        note(edgeNote)
      }
    }
  }

  private var edgeNote: LocalizedStringResource {
    let prefs = model.prefs
    guard Prefs.dockEdge == prefs.edge && prefs.position == nil else {
      return "Drag the strip along either edge, or across to the other side. Fading needs hover to open Margin, so you can find the strip by pointing at the edge."
    }
    return prefs.edge == "left"
      ? "Drag the strip along either edge, or across to the other side. It starts near the top because your Dock is on the left."
      : "Drag the strip along either edge, or across to the other side. It starts near the top because your Dock is on the right."
  }

  private var notifications: some View {
    @Bindable var prefs = model.prefs
    return VStack(alignment: .leading, spacing: 4) {
      SettingsGroup("New messages") {
        SettingsRow(label: "Show", last: false) {
          Picker("New messages", selection: $prefs.alert) {
            Text("Preview").tag("preview")
            Text("Name only").tag("name")
            Text("Glow only").tag("glow")
          }
          .labelsHidden().fixedSize()
          .control("New messages", choice: $prefs.alert, from: ["preview", "name", "glow"])
        }
        switchRow(
          "macOS notifications", Binding(get: { prefs.notifications }, set: { model.setNotifications($0) }), last: true)
      }
      if prefs.alert == "preview" {
        note("The first words show beside the strip, where anyone looking at your screen can see them.")
      }
    }
  }

  private var tools: some View {
    VStack(alignment: .leading, spacing: 4) {
      SettingsGroup {
        ToolToggles().padding(.vertical, 6)
      }
      note("Turning a tool on adds Margin’s hook to its settings, backing the file up first; turning it off removes only Margin’s entry. Ollama and LM Studio need nothing installed.")
    }
  }

  @ViewBuilder private func privacy(_ settings: PrivacySettings) -> some View {
    SettingsGroup {
      switchRow("Invisible", bind(\.invisible))
      switchRow(
        "Show me in Find friends",
        Binding(
          get: { model.settings?.findable ?? true },
          set: { on in model.updateSettings { $0.findable = on } }),
        last: true)
    }
    SettingsGroup("Friends see") {
      switchRow("Tool", bind(\.share.tool))
      switchRow("Model", bind(\.share.model))
      switchRow("Repo", bind(\.share.repo))
      switchRow("Time", bind(\.share.time))
      switchRow("Tokens", bind(\.share.tokens), last: true)
    }
    SettingsGroup("Close friends") {
      switchRow(
        "Close friends only",
        Binding(
          get: { model.settings?.audience == "close" },
          set: { on in model.updateSettings { $0.audience = on ? "close" : "everyone" } }),
        last: settings.audience != "close" || model.friends.isEmpty)
      if settings.audience == "close" {
        ForEach(Array(model.friends.enumerated()), id: \.element.id) { index, friend in
          SettingsRow(label: .verbatim(friend.displayName), last: index == model.friends.count - 1) {
            Toggle(
              friend.displayName,
              isOn: Binding(
                get: { model.settings?.closeFriends.contains(friend.handle) == true },
                set: { on in
                  model.updateSettings { s in
                    s.closeFriends.removeAll { $0 == friend.handle }
                    if on { s.closeFriends.append(friend.handle) }
                  }
                })
            )
            .toggleStyle(.checkbox).labelsHidden()
          }
          .control(
            "close:\(friend.handle)",
            toggle: Binding(
              get: { model.settings?.closeFriends.contains(friend.handle) == true },
              set: { on in
                model.updateSettings { s in
                  s.closeFriends.removeAll { $0 == friend.handle }
                  if on { s.closeFriends.append(friend.handle) }
                }
              }))
        }
      }
    }
    if settings.audience == "close" { note("Everyone else sees only online or idle.") }
    if !model.blocked.isEmpty {
      SettingsGroup("Blocked") {
        ForEach(Array(model.blocked.enumerated()), id: \.element) { index, handle in
          SettingsRow(label: .verbatim(handle), last: index == model.blocked.count - 1) {
            Button("Unblock") { model.request("unblock", ["handle": handle]) }.buttonStyle(.link)
              .control("unblock:\(handle)") { model.request("unblock", ["handle": handle]) }
          }
        }
      }
    }
    SettingsGroup("Repo overrides") {
      ForEach(settings.repos.keys.sorted(), id: \.self) { repo in
        SettingsRow(label: .verbatim(repo)) {
          HStack(spacing: 8) {
            Text(settings.repos[repo] == "hidden" ? "Hidden" : "Private").foregroundStyle(theme.secondary)
            Button {
              model.updateSettings { $0.repos[repo] = nil }
            } label: {
              Image(systemName: "minus.circle.fill").foregroundStyle(theme.tertiary)
            }
            .buttonStyle(.plain).accessibilityLabel("Remove override for \(repo)")
            .control("repo:\(repo)") { model.updateSettings { $0.repos[repo] = nil } }
          }
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
        .labelsHidden().fixedSize()
        .control("New repo mode", choice: $newRepoMode, from: ["hidden", "private"])
        Button("Add", action: addRepo)
          .control("Add repo", press: addRepo)
      }
      .padding(.vertical, 6)
    }
    note("Hide a repo entirely, or keep it shown only as “private project”, whatever GitHub says.")
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
    alert.messageText = String(localized: "Delete your Margin account?")
    alert.informativeText = String(
      localized: "Your friends, keys and anything waiting on the server are deleted. Chat history on this Mac stays until you remove Margin.")
    alert.addButton(withTitle: String(localized: "Delete"))
    alert.addButton(withTitle: String(localized: "Cancel"))
    alert.buttons.first?.hasDestructiveAction = true
    if alert.runModal() == .alertFirstButtonReturn { model.request("account.delete") }
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
    let theme =
      style == .custom
        ? model.prefs.customTheme.apply(
          model.prefs.customTheme.baseStyle.theme(
            dark: scheme == .dark || model.prefs.customTheme.baseStyle.alwaysDark, accent: model.prefs.accent.color))
        : style.theme(dark: scheme == .dark || style.alwaysDark, accent: model.prefs.accent.color)
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
    .accessibilityLabel("\(String(localized: style.name)) theme")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
