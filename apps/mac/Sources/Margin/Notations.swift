import Foundation

// Number notations from Antimatter Dimensions, ported from its MIT-licensed library
// (@antimatter-dimensions/notations 3.2.0, core and community). Each formats a whole,
// non-negative token count the way the game would with format(value, 2, 0). Notations that
// need the game's own font (Bar, Blobs) or look the same as a unit at these sizes are left out.
enum Notations {
  static func format(_ value: Double, _ unit: TokenUnit) -> String? {
    let v = max(value, 0)
    switch unit {
    case .engineering: return under1000(v) ?? mantissaExponent(v, base: 10, steps: 3)
    case .letters: return under1000(v) ?? custom(v, Array("abcdefghijklmnopqrstuvwxyz").map(String.init))
    case .emoji: return under1000(v) ?? custom(v, emoji)
    case .logarithm: return under1000(v) ?? "e" + fixed(log10(v), 2)
    case .brackets: return under1000(v) ?? brackets(v)
    case .infinity: return under1000(v) ?? fixed(log10(v) / log10(Double.greatestFiniteMagnitude), 4) + "∞"
    case .roman: return roman(v)
    case .dots: return dots(v)
    case .zalgo: return zalgo(v)
    case .hex: return hex(v)
    case .imperial: return imperial(v)
    case .clock: return clock(v)
    case .prime: return prime(v)
    case .shi: return shi(v)
    case .blind: return " "
    case .all: return all(v)
    case .greek: return under1000(v) ?? greek(v)
    case .omega: return omega(v)
    case .japanese: return under1000(v) ?? japanese(v)
    case .chinese: return chinese(v)
    case .elemental: return elemental(v, places: v < 1000 ? 0 : 2)
    case .binary: return customBase(v, digits: Array("01"))
    case .hexadecimal: return customBase(v, digits: Array("0123456789ABCDEF"))
    case .english: return english(v)
    case .flags: return under1000(v) ?? custom(v, flags)
    case .yesNo: return v == 0 ? "NO" : "YES"
    case .emojier: return emojier(v < 1000 ? fixed(v, 0) : mantissaExponent(v, base: 10, steps: 1))
    case .tritetrated: return tritetrated(v)
    case .precisePrime: return v < 1 ? "0" : primeList(factors(Int(min(v, 9_007_199_254_740_991))))
    default: return nil
    }
  }

  // MARK: shared

  private static func under1000(_ v: Double) -> String? { v < 1000 ? fixed(v, 0) : nil }

  private static func fixed(_ v: Double, _ places: Int) -> String { String(format: "%.\(places)f", v) }

  private static func superscript(_ n: Int) -> String {
    String(String(n).map { Array("⁰¹²³⁴⁵⁶⁷⁸⁹")[Int(String($0))!] })
  }

  private static func subscriptDigits(_ n: Int) -> String {
    String(String(n).map { Array("₀₁₂₃₄₅₆₇₈₉")[Int(String($0))!] })
  }

  // The game's formatMantissaWithExponent: 118.77e6 for base 10 in steps of 3.
  private static func mantissaExponent(
    _ n: Double, base: Double, steps: Int, places: Int = 2, separator: String = "e",
    mantissa format: (Double, Int) -> String = { fixed($0, $1) },
    exponent formatExponent: (Int) -> String = { String($0) }
  ) -> String {
    let realBase = pow(base, Double(steps))
    var exponent = Int(floor(log(n) / log(realBase))) * steps
    var mantissa = n / pow(base, Double(exponent))
    if !(1 <= mantissa && mantissa < realBase) {
      let adjust = Int(floor(log(mantissa) / log(realBase)))
      mantissa /= pow(realBase, Double(adjust))
      exponent += steps * adjust
    }
    var m = format(mantissa, places)
    if m == format(realBase, places) {
      m = format(1, places)
      exponent += steps
    }
    return exponent == 0 ? m : m + separator + formatExponent(exponent)
  }

  // Engineering mantissa and exponent: 118.767 and 6.
  private static func engineering(_ v: Double) -> (mantissa: Double, exponent: Int) {
    let e = Int(floor(log10(v)))
    return (v / pow(10, Double(e - e % 3)), e - e % 3)
  }

  // Letters, Emoji and Flags: the engineering mantissa, then the exponent in "digits" of the list.
  private static func custom(_ v: Double, _ letters: [String]) -> String {
    let (mantissa, exponent) = engineering(v)
    var normalized = exponent / 3
    let base = letters.count
    if normalized <= base { return fixed(mantissa, 2) + letters[normalized - 1] }
    var out: [String] = []
    while normalized > base {
      let remainder = normalized % base
      out.append(letters[(remainder == 0 ? base : remainder) - 1])
      normalized = (normalized - remainder) / base
      if remainder == 0 { normalized -= 1 }
    }
    out.append(letters[normalized - 1])
    return fixed(mantissa, 2) + out.reversed().joined()
  }

  // MARK: core

  private static let emoji = [
    "😠", "🎂", "🎄", "💀", "🍆", "👪", "🌈", "💯", "🍦", "🎃", "💋", "😂", "🌙", "⛔", "🐙", "💩", "❓", "☢", "🙈",
    "👍", "☂", "✌", "⚠", "❌", "😋", "⚡",
  ]

  private static func brackets(_ v: Double) -> String {
    let table = Array(")[{](}").map(String.init)
    let log6 = log(10) / log(6) * log10(v)
    var whole = Int(floor(log6))
    let times36 = Int(floor((log6 - floor(log6)) * 36))
    var string = ""
    while whole >= 6 {
      let remainder = whole % 6
      whole = (whole - remainder) / 6
      string = table[remainder] + string
    }
    return "e" + table[whole] + string + "." + table[times36 / 6] + table[times36 % 6]
  }

  private static let romanNumbers: [(Double, String)] = [
    (1_000_000, "M̄"), (900_000, "C̄M̄"), (500_000, "D̄"), (400_000, "C̄D̄"), (100_000, "C̄"), (90000, "X̄C̄"),
    (50000, "L̄"), (40000, "X̄L̄"), (10000, "X̄"), (9000, "ⅯX̄"), (5000, "V̄"), (4000, "ⅯV̄"), (1000, "Ⅿ"),
    (900, "ⅭⅯ"), (500, "Ⅾ"), (400, "ⅭⅮ"), (100, "Ⅽ"), (90, "ⅩⅭ"), (50, "Ⅼ"), (40, "ⅩⅬ"), (10, "Ⅹ"), (9, "ⅠⅩ"),
    (5, "Ⅴ"), (4, "ⅠⅤ"), (1, "Ⅰ"),
  ]

  private static func roman(_ v: Double) -> String {
    let maximum = 4_000_000.0
    if v < maximum { return romanize(v) }
    let maximums = log10(v) / log10(maximum)
    return romanize(pow(maximum, maximums - floor(maximums))) + "↑" + roman(maximums)
  }

  private static func romanize(_ input: Double) -> String {
    var value = input
    var out = ""
    for (number, numeral) in romanNumbers {
      while number <= value {
        out += numeral
        value -= number
      }
    }
    var twelfths = Int((floor(value * 10) * 1.2).rounded())
    if twelfths == 0 { return out.isEmpty ? "nulla" : out }
    if twelfths > 5 {
      twelfths -= 6
      out += "Ｓ"
    }
    return out + ["", "·", ":", "∴", "∷", "⁙"][twelfths]
  }

  private static let dotDigits = Array(
    "⠀⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿"
      + "⡀⡁⡂⡃⡄⡅⡆⡇⡈⡉⡊⡋⡌⡍⡎⡏⡐⡑⡒⡓⡔⡕⡖⡗⡘⡙⡚⡛⡜⡝⡞⡟⡠⡡⡢⡣⡤⡥⡦⡧⡨⡩⡪⡫⡬⡭⡮⡯⡰⡱⡲⡳⡴⡵⡶⡷⡸⡹⡺⡻⡼⡽⡾⡿"
      + "⢀⢁⢂⢃⢄⢅⢆⢇⢈⢉⢊⢋⢌⢍⢎⢏⢐⢑⢒⢓⢔⢕⢖⢗⢘⢙⢚⢛⢜⢝⢞⢟⢠⢡⢢⢣⢤⢥⢦⢧⢨⢩⢪⢫⢬⢭⢮⢯⢰⢱⢲⢳⢴⢵⢶⢷⢸⢹⢺⢻⢼⢽⢾⢿"
      + "⣀⣁⣂⣃⣄⣅⣆⣇⣈⣉⣊⣋⣌⣍⣎⣏⣐⣑⣒⣓⣔⣕⣖⣗⣘⣙⣚⣛⣜⣝⣞⣟⣠⣡⣢⣣⣤⣥⣦⣧⣨⣩⣪⣫⣬⣭⣮⣯⣰⣱⣲⣳⣴⣵⣶⣷⣸⣹⣺⣻⣼⣽⣾⣿")

  private static func dots(_ v: Double) -> String {
    if v < 16_387_063.9980315 { return dotify(v * 254) }
    let log254 = log(v) / log(254)
    let exponent = floor(log254 - 2)
    return dotify(exponent) + "⣿" + dotify(pow(254, log254 - exponent) * 254)
  }

  private static func dotify(_ raw: Double, pad: Bool = false) -> String {
    let value = Int(raw.rounded())
    if !pad && value < 254 { return String(dotDigits[value + 1]) }
    if value < 64516 { return String(dotDigits[value / 254 + 1]) + String(dotDigits[value % 254 + 1]) }
    return dotify(Double(value / 64516)) + dotify(Double(value % 64516), pad: true)
  }

  private static func zalgo(_ v: Double) -> String {
    let marks = ["\u{030D}", "\u{0336}", "\u{0353}", "\u{033F}", "\u{0489}", "\u{0330}", "\u{031A}", "\u{0338}", "\u{035A}", "\u{0337}"]
    let scaled = log10(v + 1) / 66666 * 1000
    let display = Double(fixed(scaled, 2))!
    let zalgoPart = Int(floor(abs(pow(2, 30) * (scaled - display))))
    var chars = (display == display.rounded() ? String(Int(display)) : String(display)).map(String.init)
    for (i, digit) in (String(zalgoPart) + fixed(scaled, 0)).enumerated() {
      chars[37 * i % chars.count] += marks[Int(String(digit))!]
    }
    return chars.joined()
  }

  private static func hex(_ input: Double) -> String {
    func modifiedLog(_ x: Double) -> Double {
      let floorOfLog = floor(log2(x))
      return floorOfLog + x / pow(2, floorOfLog) - 1
    }
    var value = input
    var bits = ""
    for _ in 0..<32 {
      guard value.isFinite else { break }
      if value < 0 {
        bits += "0"
        value = -modifiedLog(-value)
      } else {
        bits += "1"
        value = modifiedLog(value)
      }
    }
    var result = UInt64(bits.padding(toLength: 32, withPad: "0", startingAt: 0), radix: 2)!
    if result != UInt64(UInt32.max) && (value > 0 || (value == 0 && result % 2 == 1)) { result += 1 }
    let out = String(result, radix: 16).uppercased()
    return String(repeating: "0", count: max(0, 8 - out.count)) + out
  }

  // Tokens as picolitres of liquid, in imperial measures.
  private static let minim = 61_611_520.0
  private static let volumes: [(size: Double, name: String, step: Int)] = [
    (0, "pL", 0), (minim, "minim", 0), (minim * 60, "dram", 1), (minim * 480, "ounce", 2), (minim * 1920, "gill", 2),
    (minim * 3840, "cup", 3), (minim * 7680, "pint", 4), (minim * 15360, "quart", 4), (minim * 61440, "gallon", 4),
    (minim * 276_480, "pin", 3), (minim * 552_960, "firkin", 3), (minim * 1_105_920, "kilderkin", 4),
    (minim * 2_211_840, "barrel", 4), (minim * 3_317_760, "hogshead", 5), (minim * 4_423_680, "puncheon", 6),
    (minim * 6_635_520, "butt", 7), (minim * 13_271_040, "tun", 7),
  ]
  private static let volumeAdjectives = [
    "minute ", "tiny ", "petite ", "small ", "modest ", "medium ", "generous ", "large ", "great ", "grand ",
    "huge ", "gigantic ", "immense ", "colossal ", "vast ", "galactic ", "cosmic ", "infinite ", "eternal ",
  ]

  private static func imperial(_ v: Double) -> String {
    let maxVolume = 10 * volumes[volumes.count - 1].size
    if v < maxVolume { return volume(v, volumeAdjectives[0]) }
    let reduceRatio = log10(maxVolume / minim)
    var logValue = log10(v) - log10(maxVolume)
    var index = 1
    while logValue > reduceRatio {
      index += 1
      logValue /= reduceRatio
    }
    return volume(pow(10, logValue) * minim, volumeAdjectives[min(index, volumeAdjectives.count - 1)])
  }

  private static func volume(_ x: Double, _ adjective: String) -> String {
    let index = volumes.lastIndex { $0.size <= x } ?? 0
    if index == 0 { return metric(x) }
    if let small = smallUnits(adjective, x, index) { return small }
    let big = volumes[index]
    let numBig = floor(x / big.size)
    let remainder = x - numBig * big.size
    if index < volumes.count - 1, let almost = checkAlmost(adjective, x, 0, index + 1) { return almost }
    if let near = checkAlmost(adjective, remainder, numBig, index) { return near }
    if remainder < volumes[index - big.step].size { return pluralOrArticle(numBig, adjective + big.name) }
    var numBest = floor(remainder / volumes[index - 1].size)
    var bestIndex = index - 1
    var bestError = remainder - numBest * volumes[index - 1].size
    var third = index - 2
    while third > 0 && third > index - big.step {
      let numThird = floor(remainder / volumes[third].size)
      if numThird > 9 && third != 1 { break }
      let error = remainder - numThird * volumes[third].size
      if error < 0.99 * bestError {
        numBest = numThird
        bestIndex = third
        bestError = error
      }
      third -= 1
    }
    return bigAndSmall(adjective, numBig, big.name, numBest, volumes[bestIndex].name)
  }

  private static func metric(_ x: Double) -> String {
    func precision4(_ v: Double) -> String { fixed(v, max(0, 3 - Int(floor(log10(v))))) }
    if x < 1000 { return (x < 10 || x == x.rounded() ? fixed(x, 2) : fixed(x, 0)) + "pL" }
    if x < 1e6 { return precision4(x / 1000) + "nL" }
    return precision4(x / 1e6) + "μL"
  }

  private static func smallUnits(_ adjective: String, _ x: Double, _ index: Int) -> String? {
    let big = volumes[index]
    if index <= 3 && x + 9.5 * minim > volumes[index + 1].size {
      return almostOrShortOf(x, adjective, 1, volumes[index + 1], volumes[1])
    }
    if index == 1 {
      let deciMinims = (x * 10 / big.size).rounded()
      if deciMinims == 10 { return article(adjective + big.name) }
      return "\(fixed(deciMinims / 10, deciMinims < 100 ? 1 : 0)) \(adjective)\(big.name)s"
    }
    if index == 2 {
      let numBig = floor(x / big.size)
      let remainder = x - numBig * big.size
      if remainder > 50.5 * minim { return almostOrShortOf(x, adjective, numBig + 1, big, volumes[1]) }
      return bigAndSmall(adjective, numBig, big.name, (remainder / minim).rounded(), "minim")
    }
    return nil
  }

  private static func checkAlmost(_ adjective: String, _ x: Double, _ numBig: Double, _ index: Int) -> String? {
    let big = volumes[index]
    if x + volumes[index - big.step].size >= big.size { return "almost " + pluralOrArticle(numBig + 1, adjective + big.name) }
    let small = volumes[index + 1 - big.step]
    if x + small.size >= big.size { return shortOf(adjective, numBig + 1, big.name, 1, small.name) }
    return nil
  }

  private static func bigAndSmall(_ adjective: String, _ numBig: Double, _ big: String, _ numSmall: Double, _ small: String) -> String {
    let bigString = pluralOrArticle(numBig, adjective + big)
    return numSmall == 0 ? bigString : "\(bigString) and \(pluralOrArticle(numSmall, small))"
  }

  private static func almostOrShortOf(
    _ x: Double, _ adjective: String, _ numBig: Double, _ big: (size: Double, name: String, step: Int),
    _ small: (size: Double, name: String, step: Int)
  ) -> String {
    let short = ((numBig * big.size - x) / small.size).rounded()
    return short == 0
      ? "almost " + pluralOrArticle(numBig, adjective + big.name) : shortOf(adjective, numBig, big.name, short, small.name)
  }

  private static func shortOf(_ adjective: String, _ numBig: Double, _ big: String, _ numSmall: Double, _ small: String) -> String {
    pluralOrArticle(numSmall, small) + " short of " + pluralOrArticle(numBig, adjective + big)
  }

  private static func pluralOrArticle(_ n: Double, _ s: String) -> String {
    n == 1 ? article(s) : "\(n == n.rounded() ? String(Int(n)) : String(n)) \(s)s"
  }

  private static func article(_ s: String) -> String { ("aeiouAEIOU".contains(s.first ?? "x") ? "an " : "a ") + s }

  private static func clock(_ v: Double) -> String {
    let hours = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"]
    func hour(_ n: Double) -> String { hours[max(min(Int(floor(n)), 11), 0)] }
    if v < 12 { return hour(v) }
    let log12 = log10(v) / log10(12)
    var exponent = floor(log12)
    let low = (pow(12, log12 - exponent + 1) - 12) / 11
    if exponent < 13 { return hour(exponent - 1) + hour(low) }
    exponent -= 13
    var prefix = ""
    if exponent >= 144 {
      prefix = hour(0)
      exponent -= 144
    }
    return prefix + hour(exponent / 12) + hour(exponent.truncatingRemainder(dividingBy: 12)) + hour(low)
  }

  private static func factors(_ input: Int) -> [Int] {
    var n = input
    var out: [Int] = []
    var p = 2
    while p * p <= n {
      while n % p == 0 {
        out.append(p)
        n /= p
      }
      p += p == 2 ? 1 : 2
    }
    if n > 1 { out.append(n) }
    return out
  }

  // 2³×5 for [2, 2, 2, 5]; 0 and 1 stand for themselves.
  private static func primeList(_ list: [Int]) -> String {
    if list.isEmpty { return "1" }
    var out: [String] = []
    var i = 0
    while i < list.count {
      var count = 1
      while i + count < list.count && list[i + count] == list[i] { count += 1 }
      out.append(count > 1 ? "\(list[i])\(superscript(count))" : "\(list[i])")
      i += count
    }
    return out.joined(separator: "×")
  }

  private static func prime(_ v: Double) -> String {
    let maxInt = 10006.0
    if v <= maxInt { return floor(v) == 0 ? "0" : primeList(factors(Int(floor(v)))) }
    let exp = log10(v) / log10(maxInt)
    let base = pow(maxInt, exp / ceil(exp))
    return "(\(primeList(factors(Int(floor(base))))))^(\(primeList(factors(Int(ceil(exp))))))"
  }

  private static func shi(_ v: Double) -> String {
    let characters = Array("世使侍勢十史嗜士始室實屍市恃拭拾施是時氏濕獅矢石視試詩誓識逝適釋食")
    let scaled = pow(log10(v + 1) * 1000, 0.08)
    return (0..<3).map { i in
      String(characters[Int(floor(scaled * pow(Double(characters.count), Double(i)))) % characters.count])
    }.joined()
  }

  // ALL: a different notation as the number grows, in the game's order.
  private static func all(_ v: Double) -> String {
    let scientific = { v < 1000 ? fixed(v, 0) : mantissaExponent(v, base: 10, steps: 1) }
    let standard = {
      v < 1000
        ? fixed(v, 0)
        : mantissaExponent(v, base: 1000, steps: 1, separator: " ", exponent: { ["", "K", "M", "B", "T", "Qa", "Qt", "Sx", "Sp", "Oc", "No"][$0] })
    }
    // Bar and Blobs, which need the game's font, stand in as Blind.
    let order: [() -> String] = [
      scientific, { format(v, .letters)! }, standard, { format(v, .logarithm)! }, { brackets(v) }, { format(v, .infinity)! },
      { roman(v) }, { dots(v) }, { zalgo(v) }, { hex(v) }, { imperial(v) }, { clock(v) }, { prime(v) }, { " " }, { shi(v) },
      { " " }, { " " },
    ]
    return order[Int(floor(log2(log2(v + 2)))) % order.count]()
  }

  // MARK: community

  private static func greek(_ v: Double) -> String {
    let letters = Array("άαβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ")
    var exp = Int(floor(log10(v))) / 3
    var step = Int(pow(Double(letters.count), floor(log(Double(exp)) / log(Double(letters.count)))))
    var suffix = ""
    while step >= 1 {
      let ordinal = exp / step
      suffix.append(letters[ordinal])
      exp -= step * ordinal
      step /= letters.count
    }
    return fixed(pow(10, log10(v).truncatingRemainder(dividingBy: 3)), 2) + " " + suffix
  }

  private static func omega(_ v: Double, short: Bool = false) -> String {
    let greek = Array("βζλψΣΘΨω")
    let step = floor(v / 1000)
    let omegaAmount = floor(step / 8)
    let lastLetter = String(greek[Int(step.truncatingRemainder(dividingBy: 8))]) + subscriptDigits(Int(v.truncatingRemainder(dividingBy: 1000).rounded()))
    let omegaOrder = log(v) / log(8000)
    if omegaAmount == 0 { return lastLetter }
    if omegaAmount <= 3 { return Array(repeating: "ω", count: Int(omegaAmount)).joined(separator: "^") + "^" + lastLetter }
    if omegaAmount < 10 { return "ω(\(Int(omegaAmount)))^" + lastLetter }
    if omegaOrder < 3 { return "ω(\(omega(omegaAmount)))^" + lastLetter }
    if omegaOrder < 6 { return "ω(\(omega(omegaAmount)))" }
    return "ω[\(Int(floor(omegaOrder)))](\(omega(pow(8000, omegaOrder.truncatingRemainder(dividingBy: 1)))))"
  }

  private static func japanese(_ v: Double) -> String {
    let suffixes = ["", "万", "億", "兆", "京", "垓", "秭", "穣", "溝", "澗", "正", "載", "極", "恒河沙", "阿僧祇", "那由他", "不可思議", "無量大数"]
    let e = Int(floor(log10(v)))
    let last = min(max(0, e / 4), suffixes.count - 1)
    let mantissa = (v / pow(10, Double(4 * last)) * 10000).rounded() / 10000
    let whole = floor(mantissa)
    let sub = Int(((mantissa - whole) * 10000).rounded())
    var out = "\(Int(whole))\(suffixes[last])"
    if last >= 1 && sub != 0 { out += "\(sub)\(suffixes[last - 1])" }
    return out
  }

  private static func chinese(_ v: Double) -> String {
    let prefixes = ["", "万", "亿", "兆", "京", "垓", "秭", "穰", "沟", "涧", "正", "载", "极"]
    if v < 10000 { return chineseUnder10000(v) }
    let e = Int(floor(log10(v)))
    let exp = e / 4 * 4
    let scaled = v / pow(10, Double(exp))
    let man = floor(scaled)
    let manb = Int(floor(scaled * 10000)) % 10000
    return chineseUnder10000(man) + prefixes[exp / 4] + (manb > 0 ? chineseUnder10000(Double(manb)) + prefixes[exp / 4 - 1] : "")
  }

  private static func chineseUnder10000(_ v: Double) -> String {
    let digits = Array("〇一二三四五六七八九").map(String.init)
    let places = ["", "十", "百", "千"]
    let out = [3, 2, 1, 0].map { x -> String in
      let digit = Int(floor(v / pow(10, Double(x)))) % 10
      if digit == 0 { return "" }
      if digit == 1 && x == 1 { return places[x] }
      return digits[digit] + places[x]
    }.joined()
    return out.isEmpty ? digits[0] : out
  }

  private static let elements: [[String]] = [
    ["H"], ["He", "Li", "Be", "B", "C", "N", "O", "F"], ["Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl"],
    ["Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br"],
    ["Kr", "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I"],
    [
      "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta",
      "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At",
    ],
    [
      "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db",
      "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts",
    ],
    ["Og"],
  ]

  private static func elemental(_ v: Double, places: Int) -> String {
    var logValue = log(v) / log(118)
    var parts: [(String, Double)] = []
    while logValue >= 1 && parts.count < 4 {
      let unfloored = log(logValue) / log(118)
      let index = Int(floor(unfloored))
      let list = elements[index]
      let sub = Int(floor((unfloored - floor(unfloored)) * Double(list.count)))
      let size = pow(118, Double(index) + Double(sub) / Double(list.count))
      let n = floor(logValue / size)
      logValue -= n * size
      parts.insert((list[sub], n), at: 0)
    }
    func part(_ p: (String, Double)) -> String { p.1 == 1 ? p.0 : "\(Int(p.1)) \(p.0)" }
    if parts.count >= 4 { return parts.map(part).joined(separator: " + ") }
    let mantissa = v == 0 ? fixed(0, places) : fixed(pow(118, logValue), places)
    if parts.isEmpty { return mantissa }
    if parts.count == 1 { return "\(mantissa) × \(part(parts[0]))" }
    return "\(mantissa) × (\(parts.map(part).joined(separator: " + ")))"
  }

  // Binary and Hexadecimal: the mantissa and exponent both written in that base.
  private static func customBase(_ v: Double, digits: [Character]) -> String {
    let base = digits.count
    func mantissa(_ n: Double, _ places: Int) -> String {
      var value = Int((n * pow(Double(base), Double(places))).rounded())
      var out: [Character] = []
      repeat {
        out.append(digits[value % base])
        value /= base
      } while value > 0
      var result = String(out.reversed())
      if places > 0 {
        result = String(repeating: "0", count: max(0, places + 1 - result.count)) + result
        result = result.dropLast(places) + "." + result.suffix(places)
      }
      return result
    }
    if v < 1000 { return mantissa(v, 0) }
    return mantissaExponent(v, base: Double(base), steps: 1, mantissa: mantissa, exponent: { mantissa(Double($0), 0) })
  }

  private static func english(_ v: Double) -> String {
    if v == 0 { return "zero" }
    let places = v < 1000 ? 0 : 2
    var (m, e) = engineering(v)
    if (m * pow(10, Double(places))).rounded() >= 1000 * pow(10, Double(places)) {
      m = 1
      e += 3
    }
    let precision = pow(10, -Double(places))
    let ceiled = m + precision / 2 >= 1000
    let units = englishUnits(ceiled ? 1 : m + precision / 2, places)
    let names = ["", "thousand", "million", "billion", "trillion", "quadrillion", "quintillion", "sextillion"]
    let prefix = names[min(max((e + (ceiled ? 1 : 0)) / 3, 0), names.count - 1)]
    return prefix.isEmpty ? units : "\(units) \(prefix)"
  }

  private static func englishUnits(_ input: Double, _ places: Int) -> String {
    let units = [
      "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
      "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
    ]
    let tens = ["", "ten", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
    var e = input
    var out: [String] = []
    if e >= 100 {
      let a = Int(floor(e / 100))
      out.append("\(units[a]) hundred")
      e -= Double(a * 100)
    }
    if e < 20 {
      if e >= 1 && !out.isEmpty { out.append("and") }
      let a = Int(floor(e))
      out.append(e < 1 && input > 1 ? "" : units[a])
      e -= Double(a)
    } else {
      if !out.isEmpty { out.append("and") }
      var a = Int(floor(e / 10))
      out.append(tens[a])
      e -= Double(a * 10)
      a = Int(floor(e))
      if a != 0 {
        out.append(units[a])
        e -= Double(a)
      }
    }
    var precision = pow(10, -Double(places))
    if e >= precision && places > 0 {
      out.append("point")
      var a = 0
      while e >= precision && a < places {
        out.append(units[Int(floor(e * 10))])
        e = e * 10 - floor(e * 10)
        precision *= 10
        a += 1
      }
    }
    return out.filter { !$0.isEmpty }.joined(separator: " ")
  }

  private static let flags =
    ("AF AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ "
    + "CA CC CD CF CG CH CI CK CL CM CN CO CP CR CU CV CW CX CY CZ DE DG DJ DK DM DO DZ EA EC EE EG EH ER ES ET EU FI FJ "
    + "FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU IC ID IE IL IM IN IO IQ IR "
    + "IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM "
    + "MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT "
    + "PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TA TC TD TF TG TH TJ TK TL "
    + "TM TN TO TR TT TV TW TZ UA UG UM UN US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW")
    .split(separator: " ")
    .map { code in String(String.UnicodeScalarView(code.unicodeScalars.map { Unicode.Scalar(0x1F1E6 + $0.value - 65)! })) }

  // Scientific, with repeated digits swapped for emoji.
  private static func emojier(_ formatted: String) -> String {
    let emoji = ["🎂", "🎄", "💀", "👪", "🌈", "💯", "🎃", "💋", "😂", "🌙"]
    var chars = formatted.map(String.init)
    var seen: [Int] = []
    for i in chars.indices {
      guard let digit = Int(chars[i]) else { continue }
      if let index = seen.map({ $0 % 5 }).firstIndex(of: digit % 5) {
        chars[i] = emoji[index + 5 * (((seen.contains(digit) ? 0 : 1) + i) % 2)]
      } else {
        seen.append(digit)
      }
    }
    return chars.joined()
  }

  // x↑↑3: the x whose power tower x^(x^x) reaches the number.
  private static func tritetrated(_ v: Double) -> String {
    var low = 0.0
    var high = 16.0
    while high - low > 1e-7 {
      let mid = (low + high) / 2
      if pow(mid, pow(mid, mid)) < v { low = mid } else { high = mid }
    }
    return fixed(low, 4) + "↑↑3"
  }
}

// Ported from @antimatter-dimensions/notations, under its licence:
//
// MIT License
// 
// Copyright (c) 2019 Antimatter Dimensions
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
