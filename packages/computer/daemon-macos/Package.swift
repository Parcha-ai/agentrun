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
	],
	targets: [
		.target(name: "CComputerd"),
		.target(name: "ComputerdKit"),
		.target(
			name: "ComputerdMac",
			dependencies: ["ComputerdKit", "CComputerd"],
			linkerSettings: [
				.linkedFramework("AppKit", .when(platforms: [.macOS])),
				.linkedFramework("ApplicationServices", .when(platforms: [.macOS])),
				.linkedFramework("ScreenCaptureKit", .when(platforms: [.macOS])),
				.linkedFramework("Security", .when(platforms: [.macOS])),
				.linkedFramework("ServiceManagement", .when(platforms: [.macOS])),
				.linkedLibrary("bsm", .when(platforms: [.macOS])),
			]
		),
		.executableTarget(name: "ComputerdApp", dependencies: ["ComputerdMac", "ComputerdKit"]),
		.executableTarget(name: "ComputerdCLI", dependencies: ["ComputerdKit"]),
		.testTarget(name: "ComputerdKitTests", dependencies: ["ComputerdKit"]),
		.testTarget(name: "ComputerdMacTests", dependencies: ["ComputerdMac", "ComputerdKit"]),
	]
)
