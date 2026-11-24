import Testing

@testable import Margin

@Suite struct DesktopsTests {
  // The owner's Mac after removing three desktops: one display, five desktops, drawer on one.
  let one = [[9, 158, 4, 10, 112]]

  @Test func everyDesktop() {
    #expect(Desktops.missing(on: [4, 9, 10, 112, 158], displays: one) == [])
    #expect(Desktops.summary(on: [4, 9, 10, 112, 158], displays: one) == "5/5")
  }

  @Test func cutDownToOne() {
    #expect(Desktops.missing(on: [9], displays: one) == [158, 4, 10, 112])
    #expect(Desktops.summary(on: [9], displays: one) == "1/5")
  }

  @Test func neverShown() {
    #expect(Desktops.missing(on: [], displays: one) == [])
    #expect(Desktops.summary(on: [], displays: one) == "-")
  }

  // A window belongs only to its own display's desktops.
  @Test func twoDisplays() {
    let two = [[1, 2, 3], [7, 8]]
    #expect(Desktops.missing(on: [8], displays: two) == [7])
    #expect(Desktops.missing(on: [1, 3], displays: two) == [2])
    #expect(Desktops.summary(on: [7, 8], displays: two) == "2/2")
  }

  // A full-screen app's desktop counts like any other.
  @Test func fullScreen() {
    #expect(Desktops.missing(on: [1, 2], displays: [[1, 2, 40]]) == [40])
  }

  // A desktop that's since been removed doesn't tie a window to any display.
  @Test func removedDesktop() {
    #expect(Desktops.missing(on: [117], displays: one) == [])
    #expect(Desktops.missing(on: [117, 9], displays: one) == [158, 4, 10, 112])
  }

  @Test func noDesktopsRead() {
    #expect(Desktops.missing(on: [9], displays: []) == [])
    #expect(Desktops.summary(on: [9], displays: []) == "-")
  }

  // Shaped like the window server's list on the owner's Mac: a display's UUID and its current
  // desktop, type 0 for a desktop and 4 for a full-screen app.
  @Test func showingFullScreenApp() {
    let desk: [String: Any] = ["type": 0]
    let app: [String: Any] = ["type": 4]
    let two: [[String: Any]] = [
      ["Display Identifier": "37D8832A", "Current Space": desk],
      ["Display Identifier": "B1C2", "Current Space": app],
    ]
    #expect(!Desktops.fullScreen(display: "37D8832A", in: two))
    #expect(Desktops.fullScreen(display: "B1C2", in: two))
    // "Displays have separate Spaces" off: one entry for every display.
    #expect(Desktops.fullScreen(display: "37D8832A", in: [["Display Identifier": "Main", "Current Space": app]]))
    #expect(!Desktops.fullScreen(display: "37D8832A", in: []))
    #expect(Desktops.fullScreen(display: "b1c2", in: two))
    // "Main" stands for every display only when it's the only entry.
    let mixed: [[String: Any]] = [["Display Identifier": "Main", "Current Space": app], two[0]]
    #expect(!Desktops.fullScreen(display: "FFFF", in: mixed))
  }
}
