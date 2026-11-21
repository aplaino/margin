// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Margin",
  platforms: [.macOS("26.0")],
  dependencies: [
    // Updates outside the App Store, verified with an EdDSA key (see scripts/release.sh).
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")
  ],
  targets: [
    .executableTarget(
      name: "Margin",
      dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      path: "Sources/Margin",
      swiftSettings: [.swiftLanguageMode(.v5)],
      // Sparkle.framework ships in Margin.app/Contents/Frameworks.
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    )
  ]
)
