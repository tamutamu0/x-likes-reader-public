// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MarginCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "MarginCore", targets: ["MarginCore"]), .executable(name: "MarginSmoke", targets: ["MarginSmoke"]), .executable(name: "MarginCoreChecks", targets: ["MarginCoreChecks"])],
    targets: [
        .target(name: "MarginCore"),
        .executableTarget(name: "MarginSmoke", dependencies: ["MarginCore"]),
        .executableTarget(name: "MarginCoreChecks", dependencies: ["MarginCore"])
    ]
)
