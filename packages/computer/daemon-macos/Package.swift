// swift-tools-version: 6.0
// Computerd for macOS: the computer protocol's driver in the user's login session.
//
// ComputerdKit is the platform-free core (the wire, the protocol's types, states and refs, settle, expect and the route
// ladder) and builds on Linux too, so its tests run anywhere. ComputerdMac holds every macOS call behind the core's
// platform protocols. ComputerdApp is Computerd.app's executable, and computerd is the CLI that relays stdio to the
// app's socket.
import PackageDescription

let package = Package(
	name: "Computerd",
	platforms: [.macOS(.v14)],
	products: [
		.library(name: "ComputerdKit", targets: ["ComputerdKit"]),
		.executable(name: "ComputerdApp", targets: ["ComputerdApp"]),
		.executable(name: "computerd", targets: ["ComputerdCLI"]),
		.executable(name: "UIFixture", targets: ["UIFixture"]),
	],
	targets: [
		.target(name: "CComputerd"),
		.target(name: "ComputerdKit"),
		// The macOS layer calls AppKit, the accessibility API, ScreenCaptureKit and Security, whose types carry no
		// Sendable annotations. It builds in the Swift 5 language mode, so those are warnings; the core keeps Swift 6's
		// strict checking.
		.target(
			name: "ComputerdMac",
			dependencies: ["ComputerdKit", "CComputerd"],
			swiftSettings: [.swiftLanguageMode(.v5)],
			linkerSettings: [
				.linkedFramework("AppKit", .when(platforms: [.macOS])),
				.linkedFramework("ApplicationServices", .when(platforms: [.macOS])),
				.linkedFramework("ScreenCaptureKit", .when(platforms: [.macOS])),
				.linkedFramework("Security", .when(platforms: [.macOS])),
				.linkedFramework("ServiceManagement", .when(platforms: [.macOS])),
				.linkedLibrary("bsm", .when(platforms: [.macOS])),
			]
		),
		.executableTarget(name: "ComputerdApp", dependencies: ["ComputerdMac", "ComputerdKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
		.executableTarget(name: "ComputerdCLI", dependencies: ["ComputerdKit"]),
		// The ui conformance cases' fixture app (ai.agentrun.ui-fixture), bundled by scripts/bundle.sh. Test-only.
		.executableTarget(
			name: "UIFixture",
			swiftSettings: [.swiftLanguageMode(.v5)],
			linkerSettings: [.linkedFramework("AppKit", .when(platforms: [.macOS]))]
		),
		.testTarget(name: "ComputerdKitTests", dependencies: ["ComputerdKit"]),
		.testTarget(name: "ComputerdMacTests", dependencies: ["ComputerdMac", "ComputerdKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
	]
)
