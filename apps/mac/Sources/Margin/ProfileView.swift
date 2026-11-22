import Charts
import SwiftUI

// A friend's profile, or yours as friends see it: who they are and what they're doing, then
// their stats as a sheet: this week's three numbers as tiles, tokens on each of the last 14
// days, then today, all time and this week. Everything shown is what they chose to share.
struct ProfileView: View {
  var handle: String
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  private var isMe: Bool { handle == model.me?.handle }
  private var friend: Friend? { model.friend(handle) }
  private var name: String { isMe ? (model.me?.name ?? handle) : (friend?.displayName ?? handle) }
  private var presence: Presence? { isMe ? model.me?.presence : friend?.presence }
  private var stats: Stats? { presence?.stats }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button {
          model.profileOf = nil
        } label: {
          Image(systemName: "chevron.left").font(theme.font(13, bold: true))
            .foregroundStyle(theme.secondary).frame(width: 22, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back")
        Spacer()
      }
      .padding(.horizontal, 10).padding(.top, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header
          if isMe, model.settings?.invisible == true {
            note("You’re invisible: friends see you as offline, with no stats.")
          } else {
            if let asOf { note(asOf) }
            tiles
            chart
            groups
            if isMe { note("This is what friends see. Hidden stats are switched off in Settings → Privacy.") }
          }
        }
        .padding(.horizontal, 14).padding(.bottom, 14)
      }
      .edgeFade(8)

    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Avatar(handle: handle, name: name, size: 52)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: name).font(theme.font(15, bold: true)).fixedSize(horizontal: false, vertical: true)
        Text(verbatim: "@\(handle)").font(theme.caption).foregroundStyle(theme.secondary)
        HStack(alignment: .top, spacing: 5) {
          PresenceDot(status: presence?.status ?? "offline", size: theme.rowDot - 1).padding(.top, 4)
          Text(status).font(theme.small).foregroundStyle(theme.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 2)
      }
    }
    .padding(.top, 2)
  }

  private var status: String {
    guard let presence else { return String(localized: "offline") }
    if presence.status != "offline" || isMe { return Format.what(presence) }
    let ago = Format.ago(friend?.lastSeenAt ?? 0)
    return ago.isEmpty ? String(localized: "offline") : String(localized: "offline · last seen \(ago)")
  }

  // An offline friend's stats are from when they were last here.
  private var asOf: String? {
    guard !isMe, presence?.status == "offline", stats != nil else { return nil }
    let ago = Format.ago(friend?.lastSeenAt ?? 0)
    return ago.isEmpty ? nil : String(localized: "Stats as of \(ago)")
  }

  // MARK: This week

  private var tiles: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionLabel("This week").padding(.leading, 2)
      HStack(spacing: 6) {
        tile(stats?.week.map(Format.tokens), "tokens", shared: share(\.tokens))
        tile(stats?.promptsWeek.map(Format.tokens), "prompts", shared: share(\.prompts))
        tile(stats?.minutes.map(Format.hours), "in tools", shared: share(\.time))
      }
    }
  }

  private func tile(_ value: String?, _ label: LocalizedStringResource, shared: Bool) -> some View {
    VStack(spacing: 2) {
      Text(verbatim: shared ? (value ?? "–") : String(localized: "Hidden"))
        .font(theme.font(shared && value != nil ? 17 : 12, bold: true)).monospacedDigit()
        .foregroundStyle(shared && value != nil ? theme.text : theme.tertiary)
        .lineLimit(1).minimumScaleFactor(0.6)
        .frame(height: 22)
      Text(label).font(theme.caption).foregroundStyle(theme.secondary).lineLimit(1)
    }
    .frame(maxWidth: .infinity).padding(.vertical, 9)
    .background(RoundedRectangle(cornerRadius: theme.nested(14)).fill(theme.surface))
    .accessibilityElement(children: .combine)
  }

  // MARK: Last 14 days

  @ViewBuilder private var chart: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionLabel("Last 14 days").padding(.leading, 2)
      if let daily = stats?.daily, !daily.isEmpty {
        let peak = max(daily.max() ?? 0, 1)
        Chart(Array(daily.enumerated()), id: \.offset) { day, tokens in
          BarMark(x: .value("Day", day), y: .value("Tokens", tokens), width: .ratio(0.7))
            .foregroundStyle(day == daily.count - 1 ? theme.accent : theme.accent.opacity(0.45))
            .cornerRadius(2)
        }
        .chartXAxis(.hidden).chartYAxis(.hidden)
        .chartYScale(domain: 0...peak)
        .frame(height: 56)
        .accessibilityLabel("Tokens on each of the last 14 days")
        HStack {
          Text("2 weeks ago")
          Spacer()
          Text("Today")
        }
        .font(theme.font(10)).foregroundStyle(theme.tertiary)
      } else {
        Text(share(\.tokens) ? "Nothing yet" : "Hidden").font(theme.caption).foregroundStyle(theme.tertiary)
      }
      if let days = stats?.days {
        Text("Active \(days) of the last 14 days").font(theme.caption).foregroundStyle(theme.secondary)
      }
    }
  }

  // MARK: Today, all time, this week

  @ViewBuilder private var groups: some View {
    SettingsGroup("Today") {
      row("Tokens", stats?.today.map(Format.tokens), shared: share(\.tokens))
      row("Prompts", stats?.promptsToday.map(Format.tokens), shared: share(\.prompts), last: true)
    }
    SettingsGroup("All time") {
      row("Tokens", presence?.tokens.map(Format.tokens), shared: share(\.tokens))
      row("Prompts", stats?.prompts.map(Format.tokens), shared: share(\.prompts), last: true)
    }
    SettingsGroup("This week") {
      row("Sessions", stats?.sessions.map { "\($0)" }, shared: share(\.time))
      row("Longest session", stats?.longest.map(Format.hoursMinutes), shared: share(\.time))
      row("Mostly in", stats?.tool.map(Format.tool), shared: share(\.tool))
      row("Model", stats?.model, shared: share(\.model), last: true)
    }
  }

  private func row(_ label: LocalizedStringResource, _ value: String?, shared: Bool, last: Bool = false) -> some View {
    SettingsRow(label: label, last: last) {
      Text(verbatim: shared ? (value ?? "–") : String(localized: "Hidden"))
        .font(theme.mono).monospacedDigit()
        .foregroundStyle(shared && value != nil ? theme.text : theme.tertiary)
        .lineLimit(1).truncationMode(.middle)
    }
    .font(theme.small)
  }

  // On your own profile a switched-off stat says Hidden; a friend's is just missing.
  private func share(_ key: KeyPath<Share, Bool>) -> Bool {
    guard isMe, let share = model.settings?.share else { return true }
    return share[keyPath: key]
  }

  private func share(_ key: KeyPath<Share, Bool?>) -> Bool {
    guard isMe, let share = model.settings?.share else { return true }
    return share[keyPath: key] ?? true
  }

  private func note(_ text: String) -> some View {
    Text(verbatim: text).font(theme.caption).foregroundStyle(theme.tertiary)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func note(_ text: LocalizedStringResource) -> some View {
    Text(text).font(theme.caption).foregroundStyle(theme.tertiary)
      .fixedSize(horizontal: false, vertical: true)
  }
}

// A GitHub profile picture, with initials in the accent colour until it arrives (or if it can't).
struct Avatar: View {
  var handle: String
  var name: String
  var size: CGFloat
  @Environment(AppModel.self) private var model
  @Environment(\.theme) private var theme

  private var initials: String {
    let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" })
    return String(words.prefix(2).compactMap(\.first)).uppercased()
  }

  var body: some View {
    ZStack {
      Circle().fill(theme.accent)
      Text(verbatim: initials).font(theme.font(size * 0.36, bold: true)).foregroundStyle(theme.onAccent)
      if let image = model.avatars[handle] {
        Image(nsImage: image).resizable().scaledToFill()
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .overlay(Circle().strokeBorder(theme.border, lineWidth: 0.5))
    .onAppear { model.loadAvatar(handle) }
    .accessibilityHidden(true)
  }
}
