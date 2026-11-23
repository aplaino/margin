import Foundation

// Mirrors the local protocol in packages/protocol/src/local.ts (pushes from margind).

struct Project: Codable, Equatable {
  var visibility: String
  var repo: String?
}

struct Activity: Codable, Equatable {
  var tool: String?
  var model: String?
  var project: Project?
  var since: Double?
}

struct Stats: Codable, Equatable {
  var today: Double?
  var week: Double?
  var daily: [Double]?
  var minutes: Int?
  var days: Int?
  var promptsToday: Double?
  var promptsWeek: Double?
  var prompts: Double?
  var sessions: Int?
  var longest: Int?
  var tool: String?
  var model: String?
}

struct Presence: Codable, Equatable {
  var status: String
  var activity: Activity?
  var tokens: Double?
  var stats: Stats?
  var at: Double
}

struct Friend: Codable, Equatable, Identifiable {
  var handle: String
  var name: String?
  var presence: Presence
  var lastSeenAt: Double
  var unread: Int
  var id: String { handle }
  var displayName: String { name ?? handle }
  var isOnline: Bool { presence.status != "offline" }
}

struct ChatMessage: Codable, Equatable, Identifiable {
  var id: String
  var peer: String
  var direction: String
  var text: String
  var sentAt: Double
  var state: String?
  var readAt: Double?
  var preview: LinkPreview?
  var incoming: Bool { direction == "in" }
  var unsent: Bool { state == "unsent" }
  // Your own, not yet unsent, and sent within the last day.
  var canUndoSend: Bool { !incoming && !unsent && Date.now.timeIntervalSince1970 * 1000 - sentAt < 24 * 3600 * 1000 }
}

struct Share: Codable, Equatable {
  var tool: Bool
  var model: Bool
  var repo: Bool
  var time: Bool
  var tokens: Bool
  // Missing from an older margind, which means on.
  var prompts: Bool?
}

struct PrivacySettings: Codable, Equatable {
  var invisible: Bool
  var share: Share
  var repos: [String: String]
  var audience: String
  var closeFriends: [String]
  // Missing from an older margind, which means on.
  var findable: Bool?
  var readReceipts: Bool?
  var linkPreviews: Bool?
}

struct LinkPreview: Codable, Equatable {
  var url: String
  var title: String
  var detail: String?
  var site: String?
  // A small JPEG, base64.
  var image: String?
}

struct ToolState: Codable, Equatable, Identifiable {
  var tool: String
  var found: Bool
  var connected: Bool
  var id: String { tool }
}

struct Requests: Codable, Equatable {
  var incoming: [String]
  var outgoing: [String]
}

struct SelfInfo: Codable, Equatable {
  var handle: String?
  var name: String?
  // What close friends see, and what everyone else sees.
  var presence: Presence?
  var basic: Presence?
  var tokens: Double
  var connection: String
  var protocol_: Int

  enum CodingKeys: String, CodingKey {
    case handle, name, presence, basic, tokens, connection
    case protocol_ = "protocol"
  }
}

struct ResultData: Decodable {
  var note: String?
  var id: String?
  // Find friends, blocked handles, and a friend's safety number.
  var people: [Person]?
  var blocked: [String]?
  var handle: String?
  var safety: String?
}

// Someone in Find friends.
struct Person: Codable, Equatable, Identifiable {
  var handle: String
  var name: String?
  var requested: Bool
  var id: String { handle }
  var displayName: String { name ?? handle }
}

enum Push {
  case selfInfo(SelfInfo)
  case loginCode(userCode: String, verificationUri: String)
  case loginDone
  case loginFailed(String)
  case signedInElsewhere
  case settings(PrivacySettings)
  case tools([ToolState])
  case roster([Friend])
  case requests(Requests)
  case message(ChatMessage)
  case history(with: String, messages: [ChatMessage])
  // The newest message in each chat, most recent first.
  case chats([ChatMessage])
  case result(op: String, ok: Bool, data: ResultData?, error: String?)
  // Your account export, pretty-printed for saving to a file.
  case export(Data)
  // Crash and error reports waiting on this Mac.
  case reports(count: Int, crash: Bool)

  private struct Envelope: Decodable {
    var type: String
    var state: String?
    var userCode: String?
    var verificationUri: String?
    var error: String?
    var op: String?
    var ok: Bool?
  }
  private struct SettingsPayload: Decodable { var settings: PrivacySettings }
  private struct ToolsPayload: Decodable { var tools: [ToolState] }
  private struct RosterPayload: Decodable { var friends: [Friend] }
  private struct RequestsPayload: Decodable { var requests: Requests }
  private struct MessagePayload: Decodable { var message: ChatMessage }
  private struct ChatsPayload: Decodable { var chats: [ChatMessage] }
  private struct HistoryPayload: Decodable {
    var with: String
    var messages: [ChatMessage]
  }
  private struct ResultPayload: Decodable { var data: ResultData? }
  private struct ReportsPayload: Decodable {
    var count: Int
    var crash: Bool
  }

  static func decode(_ data: Data) -> Push? {
    let decoder = JSONDecoder()
    guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
    func payload<T: Decodable>(_ type: T.Type) -> T? { try? decoder.decode(T.self, from: data) }
    switch envelope.type {
    case "self":
      return payload(SelfInfo.self).map(Push.selfInfo)
    case "login":
      switch envelope.state {
      case "code":
        guard let code = envelope.userCode, let uri = envelope.verificationUri else { return nil }
        return .loginCode(userCode: code, verificationUri: uri)
      case "done": return .loginDone
      case "elsewhere": return .signedInElsewhere
      default: return .loginFailed(envelope.error ?? "Sign-in failed")
      }
    case "settings": return payload(SettingsPayload.self).map { .settings($0.settings) }
    case "tools": return payload(ToolsPayload.self).map { .tools($0.tools) }
    case "roster": return payload(RosterPayload.self).map { .roster($0.friends) }
    case "requests": return payload(RequestsPayload.self).map { .requests($0.requests) }
    case "message": return payload(MessagePayload.self).map { .message($0.message) }
    case "history": return payload(HistoryPayload.self).map { .history(with: $0.with, messages: $0.messages) }
    case "chats": return payload(ChatsPayload.self).map { .chats($0.chats) }
    case "reports": return payload(ReportsPayload.self).map { .reports(count: $0.count, crash: $0.crash) }
    case "result":
      if envelope.op == "account.export", envelope.ok == true,
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let export = object["data"],
        let pretty = try? JSONSerialization.data(withJSONObject: export, options: [.prettyPrinted, .sortedKeys])
      {
        return .export(pretty)
      }
      return .result(
        op: envelope.op ?? "", ok: envelope.ok ?? false,
        data: payload(ResultPayload.self)?.data, error: envelope.error)
    default: return nil
    }
  }
}
