#if os(macOS)
import ComputerdKit
import CoreGraphics
import Foundation

/// The macOS platform, put together: the accessibility tree, ScreenCaptureKit, NSWorkspace, SkyLight's background
/// input and the keyboard and mouse. Made per connection, so each sees the grants as they are when it connects.
public enum MacPlatform {
	public static func make() -> Platform {
		let sky = SkyLight.shared
		let ax = MacAccessibility(sky: sky)
		let post: Feature = CGPreflightPostEventAccess()
			? .on
			: .off("Post Event is not granted to Computerd: allow it in System Settings > Privacy & Security > Accessibility")
		return Platform(
			accessibility: ax,
			capture: MacCapture(),
			workspace: MacWorkspace(),
			background: BackgroundRoute(sky: sky),
			backgroundFeature: Feature.all(sky.feature, post),
			foreground: ForegroundRoute(accessibility: ax),
			foregroundFeature: post,
			navFeature: .off("macOS has no system back, home or app switcher: use the app's own controls or a key chord such as super+[")
		)
	}

	public static var machine: MachineInfo {
		MachineInfo(os: "macos", osVersion: macOSVersion)
	}

	/// The owner's policy; a policy file that does not parse allows no app at all, never every app.
	public static func policy() -> Policy {
		do {
			return try Policy.load()
		} catch {
			log("\(error): allowing no app until it is fixed")
			return Policy(apps: [])
		}
	}

	/// A driver for one connection.
	public static func driver() -> Driver {
		Driver(platform: make(), policy: policy(), machine: machine)
	}
}
#endif
