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
              Button {
                model.request("friend.decline", ["handle": handle])
              } label: {
                Image(systemName: "xmark").font(theme.font(11, bold: true))
                  .frame(width: 30, height: 30).foregroundStyle(theme.secondary)
                  .overlay(RoundedRectangle(cornerRadius: theme.controlRadius).strokeBorder(theme.border, lineWidth: theme.borderWidth))
              }
              .buttonStyle(.plain).accessibilityLabel("Decline \(handle)")
            }
          }
        }

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
  }
}

// A GitHub handle and a Send button, with the server's answer underneath.
struct HandleField: View {
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme
  @State private var handle = ""
  @State private var sent: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        TextField("GitHub handle", text: $handle)
          .textFieldStyle(.plain)
          .padding(.horizontal, 10).padding(.vertical, 7)
          .background(RoundedRectangle(cornerRadius: theme.controlRadius).fill(theme.surface))
          .overlay(RoundedRectangle(cornerRadius: theme.controlRadius).strokeBorder(theme.border, lineWidth: theme.borderWidth))
          .onSubmit(send)
        Button("Send", action: send)
          .buttonStyle(.plain).fontWeight(.semibold).foregroundStyle(theme.onAccent)
          .padding(.horizontal, 12).padding(.vertical, 7)
          .background(RoundedRectangle(cornerRadius: theme.controlRadius).fill(theme.accent))
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
