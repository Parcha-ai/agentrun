#if os(macOS)
import AppKit
import ApplicationServices
import ComputerdKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// The grants Computerd needs, each checked, the System Settings panes that give them, and the capture alert raised once
/// on purpose so it never pops in the middle of a task.
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

		/// The anchor of the Privacy & Security pane whose list gives it. Post Event comes with Accessibility's list.
		public var anchor: String { self == .screenRecording ? "Privacy_ScreenCapture" : "Privacy_Accessibility" }
	}

	public static var missing: [Grant] { Grant.allCases.filter { !$0.granted } }

	/// The grants in now, by name, for the grants window's board.
	public static var granted: Set<String> { Set(Grant.allCases.filter(\.granted).map(\.rawValue)) }

	/// What System Settings calls the pane with this anchor on this Mac.
	static func paneName(_ anchor: String) -> String {
		guard anchor == "Privacy_ScreenCapture" else { return "Accessibility" }
		if #available(macOS 15, *) { return "Screen & System Audio Recording" }
		return "Screen Recording"
	}

	/// The panes that hold Computerd's grants, each with its grants, in Grant's order: one tile each in the grants window.
	public static var panes: [GrantsBoard.Pane] {
		var anchors: [String] = []
		for grant in Grant.allCases where !anchors.contains(grant.anchor) { anchors.append(grant.anchor) }
		return anchors.map { anchor in
			GrantsBoard.Pane(name: paneName(anchor), anchor: anchor, grants: Grant.allCases.filter { $0.anchor == anchor }.map(\.rawValue))
		}
	}

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
