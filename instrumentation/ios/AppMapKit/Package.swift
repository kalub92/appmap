// swift-tools-version: 5.9
// AppMapKit — reference implementation of 01 (app instrumentation) for iOS.
// `APP_MAP_DEBUG` is defined only in the Debug configuration (01 §2); every test-only surface
// (deep links, router export, fixtures, debug probe) is compiled out of Release builds.
import PackageDescription

let appMapDebug: [SwiftSetting] = [
    .define("APP_MAP_DEBUG", .when(configuration: .debug)),
]

let package = Package(
    name: "AppMapKit",
    platforms: [
        .iOS(.v16),
        .macOS(.v13), // lets `swift test` run on the host; the library has no UIKit-only requirement
    ],
    products: [
        .library(name: "AppMapKit", targets: ["AppMapKit"]),
    ],
    targets: [
        .target(
            name: "AppMapKit",
            swiftSettings: appMapDebug
        ),
        .testTarget(
            name: "AppMapKitTests",
            dependencies: ["AppMapKit"],
            swiftSettings: appMapDebug
        ),
    ]
)
