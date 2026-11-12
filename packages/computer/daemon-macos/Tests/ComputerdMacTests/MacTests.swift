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
		print("hello.features on \(macOSVersion): \(String(decoding: try Coders.encode(features), as: UTF8.self))")
		print("SkyLight missing: \(SkyLight.shared.missing), _AXUIElementGetWindow: \(SkyLight.shared.getWindowFn != nil)")
	}

	func testWithoutAccessibilityObserveIsDeniedInWords() async throws {
		guard !AXIsProcessTrusted() else { throw XCTSkip("Accessibility is granted here") }
		do {
			_ = try await MacPlatform.driver().ui.observe(UiObserveParams())
			XCTFail("observe ran without Accessibility")
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .denied)
			XCTAssertTrue(e.message.contains("Accessibility"), e.message)
		}
	}

	func testAppsListHasTheFinder() {
		let list = MacPlatform.driver().apps()
		XCTAssertTrue(list.apps.contains { $0.id == "com.apple.finder" }, "\(list.apps.map(\.id))")
	}
}
#endif
