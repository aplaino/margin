import AppKit

// Links in chat: found in the text and made clickable, and previewed on the sender's Mac only
// (the page's standard preview tags and a small picture), which margind then sends encrypted
// after the message. A friend's Mac never fetches anything for a link it receives.
enum LinkPreviews {
  private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
  // Says what it is: sites like Spotify only include preview tags for link-preview fetchers,
  // and send a browser an empty page that scripts fill in.
  private static let userAgent = "Mozilla/5.0 (compatible; Margin link preview)"

  // Web links in the text, in order: https and http only, never mailto:, file: and the like.
  static func links(in text: String) -> [(range: Range<String.Index>, url: URL)] {
    guard let detector else { return [] }
    return detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
      guard let url = match.url, ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
        let range = Range(match.range, in: text)
      else { return nil }
      return (range, url)
    }
  }

  // The first https link exactly as typed, so the preview's address is found in the text.
  static func firstLink(in text: String) -> URL? {
    for link in links(in: text) {
      let typed = String(text[link.range])
      if typed.hasPrefix("https://"), let url = URL(string: typed) { return url }
    }
    return nil
  }

  // The text with its links underlined and clickable.
  static func attributed(_ text: String) -> AttributedString {
    var out = AttributedString(text)
    for link in links(in: text) {
      guard let lower = AttributedString.Index(link.range.lowerBound, within: out),
        let upper = AttributedString.Index(link.range.upperBound, within: out)
      else { continue }
      out[lower..<upper].link = link.url
      out[lower..<upper].underlineStyle = .single
    }
    return out
  }

  // Title, a line of detail, the site and a small picture, from the page's preview tags.
  static func fetch(_ url: URL) async -> LinkPreview? {
    let session = URLSession(configuration: .ephemeral)
    defer { session.finishTasksAndInvalidate() }
    guard let (data, response) = await read(url, session: session, limit: 512_000, stopAt: "</head>"),
      (response.mimeType ?? "").contains("html")
    else { return nil }
    let html = String(decoding: data, as: UTF8.self)
    let meta = metaTags(html)
    guard let title = clean(meta["og:title"] ?? meta["twitter:title"] ?? titleTag(html), 200) else { return nil }
    let page = response.url ?? url
    var preview = LinkPreview(
      url: url.absoluteString, title: title,
      detail: clean(meta["og:description"] ?? meta["twitter:description"] ?? meta["description"], 300),
      site: clean(meta["og:site_name"], 80) ?? clean(page.host()?.replacingOccurrences(of: "www.", with: ""), 80))
    if let address = meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"],
      let image = URL(string: decode(address), relativeTo: page)?.absoluteURL, image.scheme == "https"
    {
      preview.image = await thumbnail(image, session: session)
    }
    return preview
  }

  // Up to `limit` bytes of an https response (stopping early once `stopAt` has arrived); nil
  // for anything else, including a redirect away from https.
  private static func read(_ url: URL, session: URLSession, limit: Int, stopAt: String? = nil) async -> (Data, HTTPURLResponse)? {
    var request = URLRequest(url: url, timeoutInterval: 8)
    request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
    guard let (bytes, response) = try? await session.bytes(for: request),
      let http = response as? HTTPURLResponse, http.statusCode == 200, http.url?.scheme == "https"
    else { return nil }
    var data = Data()
    let marker = stopAt.map { Data($0.utf8) }
    do {
      for try await byte in bytes {
        data.append(byte)
        if data.count >= limit { break }
        if let marker, data.count % 4096 == 0, data.range(of: marker) != nil { break }
      }
    } catch {
      return nil
    }
    return (data, http)
  }

  // <meta property|name="…" content="…">, keyed by the lowercased name; the first one wins.
  private static func metaTags(_ html: String) -> [String: String] {
    guard let tag = try? NSRegularExpression(pattern: "<meta\\b[^>]*>", options: .caseInsensitive),
      let attribute = try? NSRegularExpression(
        pattern: "([a-zA-Z:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", options: [])
    else { return [:] }
    var out: [String: String] = [:]
    let all = NSRange(html.startIndex..., in: html)
    for match in tag.matches(in: html, range: all) {
      guard let range = Range(match.range, in: html) else { continue }
      let text = String(html[range])
      var attributes: [String: String] = [:]
      for a in attribute.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let name = Range(a.range(at: 1), in: text) else { continue }
        let value = Range(a.range(at: 2), in: text) ?? Range(a.range(at: 3), in: text)
        attributes[text[name].lowercased()] = value.map { String(text[$0]) } ?? ""
      }
      guard let key = (attributes["property"] ?? attributes["name"])?.lowercased(),
        let content = attributes["content"], out[key] == nil
      else { continue }
      out[key] = content
    }
    return out
  }

  private static func titleTag(_ html: String) -> String? {
    guard let regex = try? NSRegularExpression(pattern: "<title[^>]*>([^<]*)</title>", options: .caseInsensitive),
      let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
      let range = Range(match.range(at: 1), in: html)
    else { return nil }
    return String(html[range])
  }

  // HTML entities in attribute values: the named ones pages use, and numeric ones.
  private static func decode(_ text: String) -> String {
    guard text.contains("&"), let regex = try? NSRegularExpression(pattern: "&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);") else { return text }
    let named = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]
    var out = ""
    var last = text.startIndex
    for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
      guard let whole = Range(match.range, in: text), let body = Range(match.range(at: 1), in: text) else { continue }
      out += text[last..<whole.lowerBound]
      let name = String(text[body])
      let scalar: Unicode.Scalar? =
        name.hasPrefix("#x") ? UInt32(name.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init)
        : name.hasPrefix("#") ? UInt32(name.dropFirst()).flatMap(Unicode.Scalar.init) : nil
      out += scalar.map { String($0) } ?? named[name] ?? String(text[whole])
      last = whole.upperBound
    }
    return out + text[last...]
  }

  // Decoded, without control or invisible formatting characters, whitespace collapsed, and
  // short enough for the protocol (which counts UTF-16 units). Nil when nothing's left.
  private static func clean(_ text: String?, _ max: Int) -> String? {
    guard let text else { return nil }
    let visible = String(
      String.UnicodeScalarView(
        decode(text).unicodeScalars.filter {
          ![.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory)
            || $0 == "\n" || $0 == "\t"
        }))
    var out = visible.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    while out.utf16.count > max { out.removeLast() }
    return out.isEmpty ? nil : out
  }

  // A small square JPEG, base64, small enough to travel in one encrypted message.
  private static func thumbnail(_ url: URL, session: URLSession) async -> String? {
    guard let (data, _) = await read(url, session: session, limit: 4_000_000), let image = NSImage(data: data),
      image.size.width > 0, image.size.height > 0
    else { return nil }
    for (side, quality) in [(120.0, 0.75), (96.0, 0.6), (72.0, 0.5)] {
      if let jpeg = jpeg(image, side: side, quality: quality), jpeg.count * 4 / 3 + 4 < 24_000 {
        return jpeg.base64EncodedString()
      }
    }
    return nil
  }

  // Centre-cropped to a square of `side` pixels, on white.
  private static func jpeg(_ image: NSImage, side: CGFloat, quality: Double) -> Data? {
    // RGBA, since Core Graphics can't draw into 24-bit RGB; JPEG drops the alpha.
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side), bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: rep)
    else { return nil }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: side, height: side).fill()
    let scale = max(side / image.size.width, side / image.size.height)
    let drawn = NSSize(width: image.size.width * scale, height: image.size.height * scale)
    image.draw(in: NSRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
    return rep.representation(using: .jpeg, properties: [.compressionFactor: quality])
  }
}
