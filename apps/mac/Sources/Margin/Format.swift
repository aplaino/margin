import Foundation

enum Format {
  static func tokens(_ value: Double?) -> String {
    guard let value, value > 0 else { return "0" }
    func short(_ v: Double, _ suffix: String) -> String {
      let rounded = (v * 10).rounded(.down) / 10
      return (rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)) + suffix
    }
    if value >= 1_000_000_000 { return short(value / 1_000_000_000, "B") }
    if value >= 1_000_000 { return short(value / 1_000_000, "M") }
    if value >= 1_000 { return short(value / 1_000, "K") }
    return String(Int(value))
  }

  static func tool(_ id: String?) -> String {
    switch id {
    case "claude-code": "Claude Code"
    case "codex": "Codex"
    case "opencode": "OpenCode"
    case "shell": "terminal"
    default: id ?? ""
    }
  }

  static func duration(since ms: Double, now: Date = .now) -> String {
    let minutes = max(0, Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000))
    if minutes < 60 { return "\(minutes)m" }
    return "\(minutes / 60)h \(minutes % 60)m"
  }

  static func ago(_ ms: Double, now: Date = .now) -> String {
    guard ms > 0 else { return "" }
    let minutes = max(0, Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    if minutes < 60 * 24 { return "\(minutes / 60)h ago" }
    return "\(minutes / (60 * 24))d ago"
  }

  static func time(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    let formatter = DateFormatter()
    formatter.doesRelativeDateFormatting = true
    formatter.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
    formatter.timeStyle = .short
    let time = formatter.string(from: date)
    return Calendar.current.isDateInToday(date) ? "Today \(time)" : time
  }

  // "Claude Code · maya/tidepool-ui", "idle · OpenCode · private project", "online"
  static func what(_ presence: Presence) -> String {
    let idle = presence.status == "idle"
    guard let activity = presence.activity else { return idle ? "idle" : "online" }
    var parts: [String] = []
    if idle { parts.append("idle") }
    if let tool = activity.tool { parts.append(Format.tool(tool)) }
    if let project = activity.project {
      parts.append(project.visibility == "public" ? (project.repo ?? "public repo") : "private project")
    }
    return parts.isEmpty ? (idle ? "idle" : "online") : parts.joined(separator: " · ")
  }

  // "claude-opus-5-5 · 3h 4m"
  static func detail(_ presence: Presence, now: Date = .now) -> String {
    var parts: [String] = []
    if let model = presence.activity?.model { parts.append(model) }
    if let since = presence.activity?.since { parts.append(duration(since: since, now: now)) }
    return parts.joined(separator: " · ")
  }
}
