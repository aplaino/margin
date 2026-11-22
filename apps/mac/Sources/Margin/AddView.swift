import SwiftUI

struct AddView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        Text("Add a friend").font(theme.bodyBold)
        HandleField()
        Text("They’ll get a request. If they’ve already asked you, you’re friends right away.")
          .font(theme.caption).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)

        if !model.requests.incoming.isEmpty {
          SectionLabel("Requests").padding(.top, 8)
          ForEach(model.requests.incoming, id: \.self) { handle in
            HStack(spacing: 8) {
              Text(handle).fontWeight(.medium)
              Spacer()
              Button {
                model.request("friend.accept", ["handle": handle])
              } label: {
                Image(systemName: "checkmark").font(theme.font(12, bold: true))
                  .frame(width: 30, height: 30).foregroundStyle(.white)
                  .background(RoundedRectangle(cornerRadius: theme.controlRadius).fill(theme.inTool))
              }
              .buttonStyle(.plain).accessibilityLabel("Accept \(handle)")
              .control("accept:\(handle)") { model.request("friend.accept", ["handle": handle]) }
              Button {
                model.request("friend.decline", ["handle": handle])
              } label: {
                Image(systemName: "xmark").font(theme.font(11, bold: true))
                  .frame(width: 30, height: 30).foregroundStyle(theme.secondary)
                  .overlay(RoundedRectangle(cornerRadius: theme.controlRadius).strokeBorder(theme.border, lineWidth: theme.borderWidth))
              }
              .buttonStyle(.plain).accessibilityLabel("Decline \(handle)")
              .control("decline:\(handle)") { model.request("friend.decline", ["handle": handle]) }
            }
          }
        }

        FindFriends().padding(.top, 8)

        if !model.requests.outgoing.isEmpty {
          SectionLabel("Sent").padding(.top, 8)
          ForEach(model.requests.outgoing, id: \.self) { handle in
            HStack {
              Text(handle).foregroundStyle(theme.secondary)
              Spacer()
              Text("pending").font(theme.caption).foregroundStyle(theme.tertiary)
            }
          }
        }
      }
      .padding(16)
    }
    .edgeFade(10)
  }
}

// A GitHub handle and a Send button, with the server's answer underneath.
struct HandleField: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var handle = ""
  @State private var sent: String?
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        TextField("GitHub handle", text: $handle)
          .textFieldStyle(.plain)
          .padding(.horizontal, 10).padding(.vertical, 7)
          .background(RoundedRectangle(cornerRadius: theme.nested(16)).fill(theme.surface))
          .overlay(RoundedRectangle(cornerRadius: theme.nested(16)).strokeBorder(theme.border, lineWidth: theme.borderWidth))
          .focused($focused)
          .onSubmit(send)
          .control("handle") { focused = true }
        Button("Send", action: send)
          .buttonStyle(.plain).fontWeight(.semibold).foregroundStyle(theme.onAccent)
          .padding(.horizontal, 12).padding(.vertical, 7)
          .background(RoundedRectangle(cornerRadius: theme.controlRadius).fill(theme.accent))
          .control("send", press: send)
      }
      if let sent, let result = model.results["friend.request"] {
        Text(result.ok ? "Request sent to \(sent)." : (result.message == "not found" ? "No Margin user called \(sent)." : result.message ?? "Couldn’t send"))
          .font(theme.caption).foregroundStyle(result.ok ? theme.secondary : theme.danger)
      }
    }
  }

  private func send() {
    let value = handle.trimmingCharacters(in: .whitespaces).lowercased()
    guard !value.isEmpty else { return }
    model.request("friend.request", ["handle": value])
    sent = value
    handle = ""
  }
}

// People on Margin who can be found and aren't your friends yet, searchable by handle or name.
struct FindFriends: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var query = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel("Find friends")
      TextField("Search people on Margin", text: $query)
        .textFieldStyle(.plain)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: theme.nested(16)).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: theme.nested(16)).strokeBorder(theme.border, lineWidth: theme.borderWidth))
      if model.directory.isEmpty {
        Text(query.isEmpty ? "Nobody else to show yet." : "Nobody matches.")
          .font(theme.caption).foregroundStyle(theme.tertiary)
      }
      ForEach(model.directory) { person in
        HStack(spacing: 8) {
          VStack(alignment: .leading, spacing: 1) {
            Text(person.displayName).fontWeight(.medium).lineLimit(1)
            if person.name != nil {
              Text("@\(person.handle)").font(theme.caption).foregroundStyle(theme.secondary).lineLimit(1)
            }
          }
          Spacer()
          Group {
            if person.requested {
              Text("Requested").font(theme.caption).foregroundStyle(theme.tertiary)
            } else {
              Button("Add") { add(person) }.buttonStyle(.link)
                .control("find:\(person.handle)") { add(person) }
            }
          }
          .transition(.blurReplace)
          .animation(.smooth(duration: 0.25), value: person.requested)
        }
      }
      Text("People appear here unless they’ve switched it off in Settings → Privacy.")
        .font(theme.font(10.5)).foregroundStyle(theme.tertiary).fixedSize(horizontal: false, vertical: true)
    }
    // Waits a moment after typing, so each keystroke isn't a request.
    .task(id: query) {
      if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
      guard !Task.isCancelled, model.signedIn else { return }
      model.request("directory", ["query": query])
    }
    .onChange(of: model.requests.outgoing) { model.request("directory", ["query": query]) }
  }

  private func add(_ person: Person) {
    model.request("friend.request", ["handle": person.handle])
  }
}
