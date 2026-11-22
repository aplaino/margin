import SwiftUI

// First launch, inside the drawer: welcome, sign in, connect tools, add a friend.
struct SetupView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      switch model.signedIn ? model.setupStep : (model.prefs.setupDone ? .signIn : model.setupStep) {
      case .welcome: welcome
      case .guide: GuideView(onDone: { model.setupStep = .signIn }).padding(.horizontal, -20).padding(.vertical, -28)
      case .signIn: signIn
      case .tools: tools
      case .addFriend: addFriend
      }
    }
    .padding(.horizontal, 20).padding(.vertical, 28)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var welcome: some View {
    Group {
      Text("Margin").font(theme.font(20, bold: true, heading: true))
      Text("See what your friends are building, right here at the edge of your screen.")
        .foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      Text("Friends only see the tool, the model, your token count, and the repo when it’s public. Never your code, prompts, files or branches.")
        .font(theme.small).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
      Spacer()
      primary("Get started") { model.setupStep = .guide }
    }
  }

  private var signIn: some View {
    Group {
      Text("Sign in with GitHub").font(theme.title)
      if let code = model.loginCode {
        Text("Your browser opened GitHub. Enter this code:").foregroundStyle(theme.secondary)
        Text(code.code).font(.system(size: 20, weight: theme.weight, design: .monospaced)).kerning(1.5)
          .textSelection(.enabled)
          .padding(.horizontal, 18).padding(.vertical, 12)
          .background(RoundedRectangle(cornerRadius: theme.controlRadius + 2).fill(theme.surface))
          .frame(maxWidth: .infinity)
        HStack(spacing: 8) {
          Circle().fill(theme.idle).frame(width: 7, height: 7)
          Text("Waiting for GitHub…").font(theme.small).foregroundStyle(theme.secondary)
        }
      } else {
        Text("Margin only asks to read your public profile.").font(theme.small).foregroundStyle(theme.secondary)
        if let error = model.loginError {
          Text(error).font(theme.small).foregroundStyle(theme.danger).fixedSize(horizontal: false, vertical: true)
        }
        Spacer()
        primary(model.signingIn ? "Signing in…" : "Sign in with GitHub") {
          model.signingIn = true
          model.loginError = nil
          model.request("login")
        }
        .disabled(model.signingIn)
      }
      Spacer()
    }
  }

  private var tools: some View {
    Group {
      Text("Connect your tools").font(theme.title)
      Text("Margin adds a small hook to each tool you turn on, and backs up the file first. It never prints anything into your sessions.")
        .font(theme.small).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      ToolToggles()
      Spacer()
      primary("Continue") { model.setupStep = .addFriend }
    }
  }

  private var addFriend: some View {
    Group {
      Text("Add your first friend").font(theme.title)
      Text("Margin is invite-only. Add a friend by their GitHub handle; they’ll see your request in their Margin.")
        .font(theme.small).foregroundStyle(theme.secondary).fixedSize(horizontal: false, vertical: true)
      HandleField()
      Spacer()
      Button("Done") { finish() }
        .buttonStyle(.plain).frame(maxWidth: .infinity).padding(.vertical, 10)
        .overlay(RoundedRectangle(cornerRadius: theme.controlRadius).strokeBorder(theme.border, lineWidth: theme.borderWidth))
      Text("Margin then tucks into the edge of your screen.").font(theme.caption).foregroundStyle(theme.tertiary)
        .frame(maxWidth: .infinity)
    }
  }

  private func finish() {
    model.prefs.setupDone = true
    Launcher.setOpensAtLogin(true)
    model.tab = .friends
  }

  private func primary(_ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).fontWeight(.semibold).foregroundStyle(theme.onAccent)
        .frame(maxWidth: .infinity).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: theme.controlRadius).fill(theme.accent))
    }
    .buttonStyle(.plain)
  }
}

struct ToolToggles: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(model.tools) { tool in
        HStack {
          Check(Format.tool(tool.tool) == "terminal" ? "Shell (zsh)" : Format.tool(tool.tool), isOn: Binding(
            get: { model.tools.first { $0.tool == tool.tool }?.connected == true },
            set: { model.request($0 ? "tools.connect" : "tools.disconnect", ["tool": tool.tool]) }
          ))
          .toggleStyle(.checkbox)
          .disabled(!tool.found)
          if !tool.found {
            Spacer()
            Text("not found").font(theme.caption).foregroundStyle(theme.tertiary)
          }
        }
      }
      if let note = model.results["tools.connect"]?.message {
        Text(note).font(theme.caption).foregroundStyle(model.results["tools.connect"]?.ok == true ? theme.secondary : theme.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}
