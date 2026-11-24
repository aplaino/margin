import Foundation
import Testing

@testable import Margin

@Suite struct FormatTests {
  @Test func tokens() {
    #expect(Format.tokens(nil) == "0")
    #expect(Format.tokens(0) == "0")
    #expect(Format.tokens(999) == "999")
    #expect(Format.tokens(1_234) == "1.2K")
    #expect(Format.tokens(1_000_000) == "1M")
    #expect(Format.tokens(48_190_000) == "48.1M")
    #expect(Format.tokens(2_500_000_000) == "2.5B")
  }

  // The match keeps its own case and is the only bold run; a long lead-in is cut to "…".
  @Test func searchSnippet() {
    let short = Format.snippet("the Big\nfixtures", matching: "big")
    #expect(String(short.characters) == "the Big fixtures")
    let bold = short.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }
    #expect(bold.map { String(short[$0.range].characters) } == ["Big"])
    let long = Format.snippet("one two three four five six seven big", matching: "BIG", before: 6)
    #expect(String(long.characters) == "…seven big")
    #expect(String(Format.snippet("no match", matching: "zzz").characters) == "no match")
  }

  // Sent at 11:30 PM in Toronto (4:30 AM in London) and seen an hour later: yesterday's
  // message in Toronto, today's in London.
  @Test func timesFollowTheTimeZone() {
    let toronto = TimeZone(identifier: "America/Toronto")!
    let london = TimeZone(identifier: "Europe/London")!
    let sent = 1_795_408_200_000.0
    let now = Date(timeIntervalSince1970: (sent + 3_600_000) / 1000)
    #expect(Format.time(sent, in: london, now: now).hasPrefix("Today"))
    #expect(!Format.time(sent, in: toronto, now: now).hasPrefix("Today"))
    #expect(Format.readTime(sent, in: london, now: now) != Format.readTime(sent, in: toronto, now: now))
  }

  @Test func hours() {
    #expect(Format.hours(0) == "0m")
    #expect(Format.hours(45) == "45m")
    #expect(Format.hours(60) == "1h")
    #expect(Format.hours(845) == "14h")
  }

  @Test func statsLine() {
    let presence = Presence(
      status: "online", stats: Stats(today: 1_200_000, week: 8_400_000, minutes: 840, days: 9), at: 0)
    #expect(Format.stats(presence) == "1.2M · 8.4M wk · 14h · 9/14d")
    // Only what they share.
    let some = Presence(status: "online", stats: Stats(minutes: 30), at: 0)
    #expect(Format.stats(some) == "30m")
    #expect(Format.stats(Presence(status: "online", at: 0)) == "")
  }

  @Test func whatTheyAreDoing() {
    let tool = Activity(tool: "claude-code", project: Project(visibility: "public", repo: "maya/tidepool-ui"))
    #expect(Format.what(Presence(status: "online", activity: tool, at: 0)) == "Claude Code · maya/tidepool-ui")
    let hidden = Activity(tool: "codex", project: Project(visibility: "private"))
    #expect(Format.what(Presence(status: "idle", activity: hidden, at: 0)) == "idle · Codex · private project")
    #expect(Format.what(Presence(status: "online", at: 0)) == "online")
    #expect(Format.what(Presence(status: "offline", activity: tool, at: 0)) == "offline")
  }
}
