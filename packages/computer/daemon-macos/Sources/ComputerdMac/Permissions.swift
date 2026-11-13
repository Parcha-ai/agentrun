#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// The grants Computerd needs, each checked and asked for, and the capture alert raised once on purpose so it never
/// pops in the middle of a task.
public enum Permissions {
	public enum Grant: String, CaseIterable, Sendable {
		case accessibility = "Accessibility"
		case screenRecording = "Screen Recording"
		case postEvent = "Post Event"

		/// What it is for, in the onboarding window's words.
		public var purpose: String {
			switch self {
			case .accessibility: return "read apps' windows and press their buttons"
			case .screenRecording: return "see windows and the screen"
			case .postEvent: return "click and type into a window, in the background or the foreground"
			}
		}

		public var granted: Bool {
			switch self {
			case .accessibility: return AXIsProcessTrusted()
			case .screenRecording: return CGPreflightScreenCaptureAccess()
			case .postEvent: return CGPreflightPostEventAccess()
			}
		}

		/// Shows the system's own prompt; the person answers in System Settings.
		public func request() {
			switch self {
			case .accessibility:
				let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
				_ = AXIsProcessTrustedWithOptions(options)
			case .screenRecording: _ = CGRequestScreenCaptureAccess()
			case .postEvent: _ = CGRequestPostEventAccess()
			}
		}

		/// The System Settings pane where it is switched on.
		public var settings: URL {
			let pane = self == .screenRecording ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
			return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
		}
	}

	public static var missing: [Grant] { Grant.allCases.filter { !$0.granted } }

	static let alertKey = "captureAlertRaised"

	/// Whether the capture alert was raised from the onboarding window already.
	public static var captureAlertRaised: Bool { UserDefaults.standard.bool(forKey: alertKey) }

	/// Captures a corner of the screen once, so macOS asks now whether Computerd may read the screen without its
	/// picker (the alert since macOS 15), and not later, mid-task. Nil when it went through, else why not.
	public static func raiseCaptureAlert() async -> String? {
		guard Grant.screenRecording.granted else { return "Screen Recording is not granted yet" }
		do {
			let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
			guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
				return "no display is shareable"
			}
			let config = SCStreamConfiguration()
			config.sourceRect = CGRect(x: 0, y: 0, width: 8, height: 8)
			config.width = 8
			config.height = 8
			_ = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
			UserDefaults.standard.set(true, forKey: alertKey)
			return nil
		} catch {
			return error.localizedDescription
		}
	}
}
#endif
