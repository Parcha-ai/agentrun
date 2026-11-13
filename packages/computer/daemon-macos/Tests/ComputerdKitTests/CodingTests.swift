import Foundation
import XCTest
@testable import ComputerdKit

/// The wire's unions and their refusals: steps, features, image options, step results, refs and points, key chords.
final class CodingTests: XCTestCase {
	func decode<T: Codable & Sendable>(_ type: T.Type, _ text: String) throws -> T {
		try Params.decode(T.self, try JSONDecoder().decode(JSON.self, from: Data(text.utf8)), method: "m")
	}

	func refuses<T: Codable & Sendable>(_ type: T.Type, _ text: String, _ words: String, file: StaticString = #filePath, line: UInt = #line) {
		do {
			_ = try decode(type, text)
			XCTFail("\(text) was taken", file: file, line: line)
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .invalid, file: file, line: line)
			XCTAssertTrue(e.message.contains(words), "\(e.message) says \(words)", file: file, line: line)
		} catch {
			XCTFail("\(error)", file: file, line: line)
		}
	}

	func testStepsRoundTrip() throws {
		let steps: [Step] = [
			.press("@e1"), .set("@e2", value: "x"), .perform("@e3", action: "AXIncrement"),
			.click(.ref("@e1"), button: .right, count: 2), .click(.point(Point(3, 4)), button: nil, count: nil),
			.type("hi", into: "@e2"), .type("yo", into: nil), .key("super+s"), .nav(.appSwitch),
			.scroll(.point(Point(1, 2)), dx: 0, dy: -40), .drag([Point(1, 1), Point(9, 9)], ms: 200),
		]
		let params = UiActParams(state: "s1", steps: steps)
		let back = try decode(UiActParams.self, String(decoding: try Coders.encode(params), as: UTF8.self))
		XCTAssertEqual(back, params)
		XCTAssertEqual(String(decoding: try Coders.encode(Step.nav(.appSwitch)), as: UTF8.self), #"{"nav":"app_switch"}"#)
	}

	func testStepRefusals() {
		refuses(UiActParams.self, #"{"steps":[{"press":"@e1","set":"@e1"}]}"#, "exactly one of")
		refuses(UiActParams.self, #"{"steps":[{}]}"#, "exactly one of")
		refuses(UiActParams.self, #"{"steps":[{"press":"e1"}]}"#, "not a ref")
		refuses(UiActParams.self, #"{"steps":[{"click":"@e1","count":4}]}"#, "1, 2 or 3")
		refuses(UiActParams.self, #"{"steps":[{"click":[1.5,2]}]}"#, "whole window points")
		refuses(UiActParams.self, #"{"steps":[{"drag":[[1,1]]}]}"#, "2 or more points")
		refuses(UiActParams.self, #"{"steps":[{"press":"@e1","value":"x"}]}"#, "steps[0].value")
		refuses(UiActParams.self, #"{"steps":[{"nav":"up"}]}"#, "steps")
		refuses(UiActParams.self, #"{"steps":[],"timeoutMs":5}"#, "params.timeoutMs")
	}

	func testFeatureCoding() throws {
		XCTAssertEqual(String(decoding: try Coders.encode([Feature.on, .off("no grant")]), as: UTF8.self), #"[true,{"off":"no grant"}]"#)
		XCTAssertEqual(try JSONDecoder().decode([Feature].self, from: Data(#"[true,{"off":"x"}]"#.utf8)), [.on, .off("x")])
		XCTAssertThrowsError(try JSONDecoder().decode(Feature.self, from: Data("false".utf8)))
		XCTAssertEqual(Feature.all(.on, .off("a"), .off("b")), .off("a"))
	}

	func testImageOption() throws {
		XCTAssertEqual(try decode(UiObserveParams.self, #"{"image":true}"#).image, .image(maxEdge: nil))
		XCTAssertEqual(try decode(UiObserveParams.self, #"{"image":false}"#).image, ImageOption.none)
		XCTAssertEqual(try decode(UiObserveParams.self, #"{"image":{"maxEdge":800}}"#).image, .image(maxEdge: 800))
		refuses(UiObserveParams.self, #"{"image":{"maxEdge":800,"x":1}}"#, "params.image.x")
		refuses(UiObserveParams.self, #"{"image":"big"}"#, "image is true, false or {maxEdge}")
	}

	func testStepResultCoding() throws {
		let results: [StepResult] = [.ran(route: .semantic, verified: true), .error(StepError(kind: .stale, message: "gone"))]
		let text = String(decoding: try Coders.encode(results), as: UTF8.self)
		XCTAssertEqual(text, #"[{"route":"semantic","verified":true},{"error":{"kind":"stale","message":"gone"}}]"#)
		XCTAssertEqual(try JSONDecoder().decode([StepResult].self, from: Data(text.utf8)), results)
	}

	func testAppsListAlwaysSendsForeground() throws {
		XCTAssertEqual(String(decoding: try Coders.encode(AppsListResult(apps: [], foreground: nil)), as: UTF8.self), #"{"apps":[],"foreground":null}"#)
	}

	func testKeyChords() throws {
		XCTAssertEqual(try KeyChord.parse("super+s"), KeyChord(modifiers: [.cmd], key: "s"))
		XCTAssertEqual(try KeyChord.parse("ctrl+shift+t").text, "ctrl+shift+t")
		XCTAssertEqual(try KeyChord.parse("shift+ctrl+t").text, "ctrl+shift+t")
		XCTAssertEqual(try KeyChord.parse("enter"), KeyChord(modifiers: [], key: "enter"))
		XCTAssertEqual(try KeyChord.parse("A"), KeyChord(modifiers: [], key: "A"))
		XCTAssertEqual(try KeyChord.parse("shift"), KeyChord(modifiers: [], key: "shift"))
		XCTAssertEqual(try KeyChord.parse("super+f5"), KeyChord(modifiers: [.cmd], key: "f5"))
		XCTAssertEqual(try KeyChord.parse("+"), KeyChord(modifiers: [], key: "+"))
		XCTAssertEqual(try KeyChord.parse("shift++"), KeyChord(modifiers: [.shift], key: "+"))
		XCTAssertEqual(try KeyChord.parse("ctrl+shift++").text, "ctrl+shift++")
		for wrong in ["", "cmd+s", "Enter", "super+", "a b", "+++", "tab++", "tab+s", "super+return", " "] {
			XCTAssertThrowsError(try KeyChord.parse(wrong), wrong)
		}
	}
}
