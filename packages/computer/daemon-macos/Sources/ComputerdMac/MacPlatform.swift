#if os(macOS)
import ComputerdKit
import CoreGraphics
import Foundation
import IOKit

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
			navFeature: .off("macOS has no system back, home or app switcher: use the app's own controls or a key chord such as super+["),
			raw: HIDInput.shared,
			person: PersonWatch.shared
		)
	}

	public static var machine: MachineInfo {
		let build = sysctl("kern.osversion").map { " (\($0))" } ?? ""
		return MachineInfo(os: "macos", osVersion: macOSVersion + build, device: Device(maker: "Apple", model: model))
	}

	/// The Mac's model as a person knows it, "MacBook Pro (14-inch, 2023)", where the device tree names it (Apple
	/// silicon); else its model identifier, "Mac14,9" or "VirtualMac2,1".
	static var model: String {
		let product = IORegistryEntryFromPath(kIOMainPortDefault, "IODeviceTree:/product")
		if product != 0 {
			defer { IOObjectRelease(product) }
			if let data = IORegistryEntryCreateCFProperty(product, "product-name" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Data {
				let name = String(decoding: data.prefix { $0 != 0 }, as: UTF8.self)
				if !name.isEmpty { return name }
			}
		}
		return sysctl("hw.model") ?? "Mac"
	}

	static func sysctl(_ name: String) -> String? {
		var size = 0
		guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
		var bytes = [UInt8](repeating: 0, count: size)
		guard sysctlbyname(name, &bytes, &size, nil, 0) == 0 else { return nil }
		let text = String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
		return text.isEmpty ? nil : text
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
		// One line per ui.act in Computerd.log: where its time went.
		Driver(platform: make(), policy: policy(), machine: machine, timing: Timing(trace: { log($0) }))
	}
}
#endif
