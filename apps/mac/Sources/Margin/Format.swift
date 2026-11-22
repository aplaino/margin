import Foundation

// The unit or notation your own token total is shown in (Settings → General).
enum TokenUnit: String, CaseIterable {
  case exact, auto, k, m, b, t, lakh, crore
  // Antimatter Dimensions' notations (Notations.swift), then its community ones.
  case engineering, letters, emoji, logarithm, brackets, infinity, roman, dots, zalgo, hex, imperial, clock, prime, shi
  case blind, all
  case greek, omega, japanese, chinese, elemental, binary, hexadecimal, english, flags, yesNo, emojier, tritetrated
  case precisePrime

  var title: LocalizedStringResource {
    switch self {
    case .exact: "Exact"
    case .auto: "Auto"
    case .k: "Thousands (K)"
    case .m: "Millions (M)"
    case .b: "Billions (B)"
    case .t: "Trillions (T)"
    case .lakh: "Lakh (L)"
    case .crore: "Crore (Cr)"
    case .engineering: "Engineering"
    case .letters: "Letters"
    case .emoji: "Emoji"
    case .logarithm: "Logarithm"
    case .brackets: "Brackets"
    case .infinity: "Infinity"
    case .roman: "Roman"
    case .dots: "Dots"
    case .zalgo: "Zalgo"
    case .hex: "Hex"
    case .imperial: "Imperial"
    case .clock: "Clock"
    case .prime: "Prime"
    case .shi: "Shi"
    case .blind: "Blind"
    case .all: "All"
    case .greek: "Greek Letters"
    case .omega: "Omega"
    case .japanese: "Japanese"
    case .chinese: "Chinese"
    case .elemental: "Elemental"
    case .binary: "Binary"
    case .hexadecimal: "Hexadecimal"
    case .english: "English"
    case .flags: "Flags"
    case .yesNo: "Yes/No"
    case .emojier: "Emojier"
    case .tritetrated: "Tritetrated"
    case .precisePrime: "Precise Prime"
    }
  }

  var scale: (divisor: Double, suffix: String)? {
    switch self {
    case .k: (1e3, "K")
    case .m: (1e6, "M")
    case .b: (1e9, "B")
    case .t: (1e12, "T")
    case .lakh: (1e5, "L")
    case .crore: (1e7, "Cr")
    default: nil
    }
  }
}

enum Format {
  // Your own total: every digit, in a fixed unit, or as 1.19 × 10⁸.
  static func total(_ value: Double?, unit: TokenUnit, scientific: Bool) -> String {
    let value = max(value ?? 0, 0)
    if scientific {
      guard value > 0 else { return "0" }
      // "1.19e+08" → "1.19 × 10⁸"
      let parts = String(format: "%.2e", value).split(separator: "e")
      let exponent = String(Int(parts[1]) ?? 0)
      let superscript = String(exponent.map { Array("⁰¹²³⁴⁵⁶⁷⁸⁹")[Int(String($0)) ?? 0] })
      return "\(parts[0]) × 10\(superscript)"
    }
    if let notation = Notations.format(value, unit) { return notation }
    guard let (divisor, suffix) = unit.scale else {
      return unit == .exact ? String(Int(value)) : tokens(value)
    }
    let scaled = value / divisor
    if scaled == 0 { return "0" + suffix }
    if scaled >= 1 {
      let rounded = (scaled * 10).rounded(.down) / 10
      return (rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)) + suffix
    }
    // Under one unit: enough decimals for three significant digits, like 0.000119T.
    let decimals = Int((-log10(scaled)).rounded(.up)) + 2
    return String(format: "%.\(decimals)f", scaled) + suffix
  }

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
    case "gemini-cli": "Gemini CLI"
    case "qwen-code": "Qwen Code"
    case "factory": "Factory"
    case "codebuddy": "CodeBuddy"
    case "qoder": "Qoder"
    case "kimi-code": "Kimi Code"
    case "cursor": "Cursor"
    case "ollama": "Ollama"
    case "lm-studio": "LM Studio"
    case "shell": String(localized: "terminal")
    default: id ?? ""
    }
  }

  // "3h 4m", in the language's own short units.
  static func duration(since ms: Double, now: Date = .now) -> String {
    let minutes = max(0, Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000))
    let formatter = DateComponentsFormatter()
    formatter.allowedUnits = minutes < 60 ? [.minute] : [.hour, .minute]
    formatter.unitsStyle = .abbreviated
    formatter.zeroFormattingBehavior = .pad
    return formatter.string(from: TimeInterval(minutes * 60)) ?? ""
  }

  static func ago(_ ms: Double, now: Date = .now) -> String {
    guard ms > 0 else { return "" }
    let minutes = max(0, Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000))
    if minutes < 1 { return String(localized: "just now") }
    if minutes < 60 { return String(localized: "\(minutes)m ago") }
    if minutes < 60 * 24 { return String(localized: "\(minutes / 60)h ago") }
    return String(localized: "\(minutes / (60 * 24))d ago")
  }

  static func time(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    let formatter = DateFormatter()
    formatter.doesRelativeDateFormatting = true
    formatter.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
    formatter.timeStyle = .short
    let time = formatter.string(from: date)
    return Calendar.current.isDateInToday(date) ? String(localized: "Today \(time)") : time
  }

  // "Claude Code · maya/tidepool-ui", "idle · OpenCode · private project", "online"
  static func what(_ presence: Presence) -> String {
    if presence.status == "offline" { return String(localized: "offline") }
    let idle = presence.status == "idle"
    let state = idle ? String(localized: "idle") : String(localized: "online")
    guard let activity = presence.activity else { return state }
    var parts: [String] = []
    if idle { parts.append(state) }
    if let tool = activity.tool { parts.append(Format.tool(tool)) }
    if let project = activity.project {
      parts.append(
        project.visibility == "public" ? (project.repo ?? String(localized: "public repo")) : String(localized: "private project"))
    }
    return parts.isEmpty ? state : parts.joined(separator: " · ")
  }

  // "1.2M · 8.4M wk · 14h · 9/14d": tokens today and this week, time in a tool this week,
  // active days of the last 14. Each part only if they share it.
  static func stats(_ presence: Presence) -> String {
    guard let stats = presence.stats else { return "" }
    var parts: [String] = []
    if let today = stats.today { parts.append(tokens(today)) }
    if let week = stats.week { parts.append(String(localized: "\(tokens(week)) wk")) }
    if let minutes = stats.minutes {
      parts.append(minutes < 60 ? String(localized: "\(minutes)m") : String(localized: "\(minutes / 60)h"))
    }
    if let days = stats.days { parts.append(String(localized: "\(days)/14d")) }
    return parts.joined(separator: " · ")
  }

  // "claude-opus-5-5 · 3h 4m"
  static func detail(_ presence: Presence, now: Date = .now) -> String {
    var parts: [String] = []
    if let model = presence.activity?.model { parts.append(model) }
    if let since = presence.activity?.since { parts.append(duration(since: since, now: now)) }
    return parts.joined(separator: " · ")
  }
}
