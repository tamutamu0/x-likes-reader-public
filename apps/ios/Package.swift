// swift-tools-version: 6.0
import PackageDescription
// macOS preview build uses the same SwiftUI screen sources. It does not replace
// an iOS Simulator/device build, which needs Xcode.
let package = Package(
    name: "MarginPreview",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "Core")],
    targets: [.executableTarget(
        name: "MarginPreview", dependencies: [.product(name: "MarginCore", package: "Core")],
        path: "App", resources: [.process("GeneratedResources")]
    )]
)
