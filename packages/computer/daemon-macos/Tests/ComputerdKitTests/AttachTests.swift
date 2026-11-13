import Foundation
import XCTest
@testable import ComputerdKit

/// The attach binding's rules as attach.md states them: where it dials, when it stops, how long it waits.
final class AttachTests: XCTestCase {
	func testRedialDoublesToAMinuteLessUpToAFifth() {
		XCTAssertEqual(Attach.redialDelayMs(0, random: 0), 1000)
		XCTAssertEqual(Attach.redialDelayMs(1, random: 0), 2000)
		XCTAssertEqual(Attach.redialDelayMs(5, random: 0), 32000)
		XCTAssertEqual(Attach.redialDelayMs(6, random: 0), 60000)
		XCTAssertEqual(Attach.redialDelayMs(400, random: 0), 60000)
		XCTAssertEqual(Attach.redialDelayMs(0, random: 0.999_999), 800)
		XCTAssertEqual(Attach.redialDelayMs(-3, random: 0.5), 900)
	}

	func testOnlyTheFourCodesThatNeedAPersonStop() {
		for code in [1000, 1001, 1003, 1006, 1009, 4408, 4409, 4999] { XCTAssertNil(Attach.stop(code), "\(code)") }
		XCTAssertTrue(Attach.stop(4400)!.contains("pair it again"))
		XCTAssertTrue(Attach.stop(4401)!.contains("pair it again"))
		XCTAssertTrue(Attach.stop(4426)!.contains("update Computerd"))
	}

	func testTheSubprotocolNamesTheVersion() {
		XCTAssertEqual(Attach.subprotocol, "agentrun.computer.0.2")
	}

	func testPairingCodesAreMadeCanonical() {
		XCTAssertEqual(Attach.pairingCode("k7pd-w3qx"), "K7PD-W3QX")
		XCTAssertEqual(Attach.pairingCode("K7PDW3QX"), "K7PD-W3QX")
		XCTAssertNil(Attach.pairingCode("K7PD-W3Q0"), "0 is not in the alphabet")
		XCTAssertNil(Attach.pairingCode("K7PD-W3QI"), "I is not in the alphabet")
		XCTAssertNil(Attach.pairingCode("K7PD-W3Q"))
	}

	func testItDialsTheAttachPathOverWss() throws {
		let s = AttachSettings(server: "https://agentrun.example/base/", computer: "c1")
		XCTAssertEqual(try s.attachURL().absoluteString, "wss://agentrun.example/base/v2/computers/attach")
		XCTAssertEqual(try AttachSettings.pairURL("https://agentrun.example").absoluteString, "https://agentrun.example/v2/computers/pair")
		let local = AttachSettings(server: "http://localhost:8080", computer: "c1")
		XCTAssertEqual(try local.attachURL().absoluteString, "ws://localhost:8080/v2/computers/attach")
	}

	func testPlainHttpIsOnlyForThisMachine() {
		XCTAssertThrowsError(try AttachSettings.base("http://agentrun.example"))
		XCTAssertThrowsError(try AttachSettings.base("https://agentrun.example/?token=x"))
		XCTAssertThrowsError(try AttachSettings.base("agentrun.example"))
	}

	func testSettingsKeepNoToken() throws {
		let data = try Coders.encode(AttachSettings(server: "https://a.example", computer: "c1"))
		XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"computer":"c1","server":"https://a.example"}"#)
	}
}
