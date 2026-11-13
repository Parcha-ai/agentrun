#if os(macOS)
import ApplicationServices
@testable import ComputerdKit
import CoreGraphics
import Foundation
import XCTest
@testable import ComputerdMac

/// The macOS layer's pure parts, and what this Mac offers. A CI runner holds no grants, so a feature it lacks must be
/// off with a reason a person can act on, never on and failing.
final class MacTests: XCTestCase {
	func testEveryKeyNameAndPrintableCharacterHasAKey() {
		for name in keyNames { XCTAssertNotNil(Keycodes.code(name), name) }
		for v in 0x21...0x7e {
			let c = String(UnicodeScalar(UInt8(v)))
			XCTAssertNotNil(Keycodes.code(c), c)
		}
		XCTAssertEqual(Keycodes.code("a")?.shift, false)
		XCTAssertEqual(Keycodes.code("A")?.shift, true)
		XCTAssertEqual(Keycodes.code("?")?.code, Keycodes.code("/")?.code)
	}

	func testAChordHoldsItsModifiersAroundTheKey() throws {
		let events = try Keycodes.events(try KeyChord.parse("super+shift+s"), source: nil)
		let codes = events.map { $0.getIntegerValueField(.keyboardEventKeycode) }
		XCTAssertEqual(codes, [0x38, 0x37, 0x01, 0x01, 0x37, 0x38].map(Int64.init))
		// The system makes a modifier key's event a flags change; the flags say which are held.
		XCTAssertEqual(events.map(\.type), [.flagsChanged, .flagsChanged, .keyDown, .keyUp, .flagsChanged, .flagsChanged])
		XCTAssertEqual(events.map { $0.flags.contains(.maskCommand) }, [false, true, true, true, false, false])
		XCTAssertTrue(events[2].flags.contains(.maskCommand))
		XCTAssertTrue(events[2].flags.contains(.maskShift))
	}

	func testAShiftedCharacterIsTypedWithShift() throws {
		let events = try Keycodes.events(try KeyChord.parse("A"), source: nil)
		XCTAssertEqual(events.count, 4)
		XCTAssertTrue(events[1].flags.contains(.maskShift))
	}

	func testTextIsSentInChunksOfAtMost20Units() throws {
		let events = try Keycodes.textEvents(String(repeating: "x", count: 45), source: nil)
		XCTAssertEqual(events.count, 6, "3 chunks, a down and an up each")
	}

	func testTheFocusRecordsHaveTheirLayout() {
		let on = SkyLight.activationRecord(window: 0x0102_0304, focused: true)
		XCTAssertEqual(on.count, 0xF8)
		XCTAssertEqual(on[0x04], 0xF8)
		XCTAssertEqual(on[0x08], 0x0D)
		XCTAssertEqual(Array(on[0x3C...0x3F]), [0x04, 0x03, 0x02, 0x01])
		XCTAssertEqual(on[0x8A], 0x01)
		XCTAssertEqual(SkyLight.activationRecord(window: 7, focused: false)[0x8A], 0x02)
		let key = SkyLight.keyWindowRecords(window: 9)
		XCTAssertEqual(key.map { $0[0x08] }, [0x01, 0x02])
		XCTAssertEqual(key[0][0x3A], 0x10)
		XCTAssertTrue(key[0][0x20..<0x30].allSatisfy { $0 == 0xFF })
	}

	func testTheClickRecipePrimesThenClicksCountTimes() {
		let steps = BackgroundRoute.clickRecipe(.left, count: 2)
		XCTAssertEqual(steps.map(\.type), [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
		XCTAssertEqual(steps.map(\.clickState), [0, 1, 1, 1, 1, 2, 2])
		XCTAssertEqual(steps.map(\.atTarget), [true, false, false, true, true, true, true])
		XCTAssertEqual(BackgroundRoute.clickRecipe(.right, count: 1).map(\.type)[3], .rightMouseDown)
	}

	func testADragPassesThroughEveryPoint() {
		let points = dragPoints([Point(0, 0), Point(100, 0), Point(100, 50)], ms: 480)
		XCTAssertEqual(points.first, CGPoint(x: 0, y: 0))
		XCTAssertEqual(points.last, CGPoint(x: 100, y: 50))
		XCTAssertTrue(points.contains(CGPoint(x: 100, y: 0)))
		XCTAssertEqual(points.count, 31, "30 moves over 480 ms")
	}

	func testRolesMapOntoTheProtocols() {
		XCTAssertEqual(Roles.map(role: "AXButton", subrole: nil, parentRole: nil), "button")
		XCTAssertEqual(Roles.map(role: "AXTextField", subrole: "AXSearchField", parentRole: nil), "searchbox")
		XCTAssertEqual(Roles.map(role: "AXCheckBox", subrole: "AXSwitch", parentRole: nil), "switch")
		XCTAssertEqual(Roles.map(role: "AXGroup", subrole: nil, parentRole: "list"), "listitem")
		XCTAssertEqual(Roles.map(role: "AXUnknownThing", subrole: nil, parentRole: nil), "generic")
		for role in Roles.byRole.values { XCTAssertTrue(uiRoles.contains(role), role) }
		for role in Roles.bySubrole.values { XCTAssertTrue(uiRoles.contains(role), role) }
	}

	func testTitleBarButtonsAreNamedFromTheirSubrole() {
		XCTAssertEqual(Roles.name(title: nil, description: nil, subrole: "AXCloseButton"), "Close")
		XCTAssertEqual(Roles.name(title: nil, description: nil, subrole: "AXMinimizeButton"), "Minimize")
		XCTAssertEqual(Roles.name(title: nil, description: nil, subrole: "AXZoomButton"), "Zoom")
		XCTAssertEqual(Roles.name(title: nil, description: nil, subrole: "AXFullScreenButton"), "Full Screen")
		// A title or a description the app gave wins; any other subrole gives no name.
		XCTAssertEqual(Roles.name(title: "Done", description: "finish", subrole: "AXCloseButton"), "Done")
		XCTAssertEqual(Roles.name(title: nil, description: "close tab", subrole: "AXCloseButton"), "close tab")
		XCTAssertNil(Roles.name(title: nil, description: nil, subrole: "AXSearchField"))
		XCTAssertNil(Roles.name(title: nil, description: nil, subrole: nil))
	}

	func testHelloSaysEveryFeatureWithAReason() throws {
		let hello = MacPlatform.driver().hello()
		XCTAssertEqual(hello.os, "macos")
		XCTAssertNotNil(hello.screen, "the runner's Aqua session has a display")
		let features = try XCTUnwrap(hello.features)
		XCTAssertEqual(Set(features.keys), Set(FeatureName.all))
		for (name, feature) in features {
			if case .off(let reason) = feature { XCTAssertGreaterThan(reason.count, 20, "\(name): \(reason)") }
		}
		// What this Mac has, for the CI log.
		print("hello.features on \(hello.osVersion ?? "?"), \(hello.device.map { "\($0.maker) \($0.model)" } ?? "?"): \(String(decoding: try Coders.encode(features), as: UTF8.self))")
		print("SkyLight missing: \(SkyLight.shared.missing), _AXUIElementGetWindow: \(SkyLight.shared.getWindowFn != nil)")
		XCTAssertEqual(hello.device?.maker, "Apple")
		XCTAssertTrue(hello.osVersion?.contains("(") == true, "osVersion carries the build: \(hello.osVersion ?? "")")
	}

	/// The window list finds the same window, by the same id, as the tree does, so a state read without the tree and one
	/// read with it name windows alike.
	func testTheWindowListAndTheTreeAgreeOnWindowIDs() throws {
		let platform = MacPlatform.make()
		guard platform.accessibility.feature.isOn, platform.capture.feature.isOn else {
			throw XCTSkip("needs Accessibility and Screen Recording here: \(platform.accessibility.feature), \(platform.capture.feature)")
		}
		let front: ResolvedTarget
		do {
			front = try platform.accessibility.resolve(nil)
		} catch {
			throw XCTSkip("the app in front has no window: \(error)")
		}
		let listed = try platform.capture.resolve(Target(app: front.app.id, window: front.window.id))
		XCTAssertEqual(listed.window.id, front.window.id)
		XCTAssertEqual(listed.window.bounds, front.window.bounds)
		print("front: \(front.app.id) window \(front.window.id) \(front.window.bounds)")
	}

	func testObserveSaysWhatItCannotSee() async throws {
		let platform = MacPlatform.make()
		do {
			let r = try await MacPlatform.driver().ui.observe(UiObserveParams())
			print("observe: \(r.app.id) window \(r.window.id), \(r.nodes.count) nodes, image \(r.image.map { "\($0.width)x\($0.height)" } ?? "none"), empty \(r.empty ?? "-")")
			if !platform.accessibility.feature.isOn {
				XCTAssertEqual(r.nodes, [])
				XCTAssertNotNil(r.empty)
				XCTAssertNotNil(r.image)
			}
		} catch let e as RPCError where e.kind == .notFound {
			print("observe: \(e.message)")
		} catch let e as RPCError where e.kind == .denied {
			XCTAssertFalse(platform.accessibility.feature.isOn || platform.capture.feature.isOn, e.message)
			XCTAssertTrue(e.message.contains("Accessibility") && e.message.contains("Screen Recording"), e.message)
		}
	}

	func testAppsListHasTheFinder() {
		let list = MacPlatform.driver().apps()
		XCTAssertTrue(list.apps.contains { $0.id == "com.apple.finder" }, "\(list.apps.map(\.id))")
	}

	func testAPersonsInputIsWhatComputerdDidNotPost() {
		let watch = PersonWatch(watching: false)
		let clock = SystemClock()
		// Computerd's own events are not a person's.
		watch.record(source: Int64(getpid()))
		XCTAssertNil(watch.lastInput())
		// Anyone else's are, at when the monitor saw them.
		let before = clock.now()
		watch.record(source: 1)
		let kept = watch.lastInput()!
		XCTAssertGreaterThanOrEqual(kept, before)
		XCTAssertLessThanOrEqual(kept, clock.now())
		// A modifier pressed on its own is the keyboard too.
		XCTAssertTrue(PersonWatch.kinds.contains(.flagsChanged))
	}

	/// The grants window shows one tile per pane: Accessibility's list gives Post Event too, so three grants are two panes.
	func testEveryGrantIsInOnePaneAndTheBoardSeesThemAll() {
		let panes = Permissions.panes
		XCTAssertEqual(panes.map(\.anchor), ["Privacy_Accessibility", "Privacy_ScreenCapture"])
		XCTAssertEqual(panes[0].grants, ["Accessibility", "Post Event"])
		XCTAssertEqual(panes[1].grants, ["Screen Recording"])
		XCTAssertTrue(["Accessibility", "Device Control and Data Access"].contains(panes[0].name), panes[0].name)
		XCTAssertTrue(panes[1].name.hasPrefix("Screen"), panes[1].name)
		XCTAssertEqual(Set(panes.flatMap(\.grants)), Set(Permissions.Grant.allCases.map(\.rawValue)))
		// A runner without grants: the board opens the first pane still waiting, and is done only with every grant.
		var board = GrantsBoard(panes: panes)
		let steps = board.observe(Permissions.granted)
		XCTAssertEqual(steps == [.done], Permissions.missing.isEmpty)
	}
}
#endif
