// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Margin",
  platforms: [.macOS("26.0")],
  targets: [
    .executableTarget(
      name: "Margin",
      path: "Sources/Margin",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
