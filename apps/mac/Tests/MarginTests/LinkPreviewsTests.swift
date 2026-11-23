import Foundation
import Testing

@testable import Margin

@Suite struct LinkPreviewsTests {
  @Test func findsWebLinksOnly() {
    let text = "listen https://open.spotify.com/track/0Uq?si=3c, docs http://example.com and mail me@example.com"
    let links = LinkPreviews.links(in: text).map(\.url.absoluteString)
    #expect(links == ["https://open.spotify.com/track/0Uq?si=3c", "http://example.com"])
  }

  @Test func previewsOnlyTheFirstHttpsLinkAsTyped() {
    #expect(LinkPreviews.firstLink(in: "see http://a.com then https://b.com/x.")?.absoluteString == "https://b.com/x")
    #expect(LinkPreviews.firstLink(in: "only http://a.com") == nil)
    #expect(LinkPreviews.firstLink(in: "no links here") == nil)
  }

  @Test func linksAreClickable() {
    let text = "go to https://example.com now"
    let linked = LinkPreviews.attributed(text)
    let runs = linked.runs.compactMap(\.link)
    #expect(runs == [URL(string: "https://example.com")!])
    #expect(String(linked.characters) == text)
  }

  // Addresses that need no DNS lookup to judge.
  @Test func refusesLocalAddresses() {
    for address in [
      "https://192.168.1.1/", "https://10.0.0.1/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/",
      "https://router.local/", "https://169.254.169.254/latest/", "https://100.64.0.1/", "http://93.184.215.14/",
      "https://user:pass@93.184.215.14/",
    ] {
      #expect(!LinkPreviews.isPublic(URL(string: address)!), "\(address)")
    }
    #expect(LinkPreviews.isPublic(URL(string: "https://93.184.215.14/")!))
  }

  @Test func decodesOnlySmallJpegs() {
    let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]).base64EncodedString()
    #expect(LinkPreviews.image(png) == nil)
    #expect(LinkPreviews.image("not base64") == nil)
  }
}
