import Foundation
import XCTest
@testable import ComputerdKit

/// input.actions: the batch checked whole as checkActions checks it, then run on the keyboard and mouse in order, the
/// screen's pixels in points (the fake screen is 1440 by 900 points at scale 2), until the first failure.
final class InputTests: XCTestCase {
	var os: FakeOS!
	let desktop: [Group] = Driver.groups

	override func setUp() {
		os = FakeOS()
		held = InputHeld()
	}

	/// What this test's batches left down, as a connection's driver keeps it.
	var held: InputHeld!

	func json(_ text: String) -> JSON {
		try! JSONDecoder().decode(JSON.self, from: Data(text.utf8))
	}

	func refused(_ actions: String, _ groups: [Group]? = nil, at index: Int, _ kind: ErrorKind, file: StaticString = #filePath, line: UInt = #line) {
		let (_, failed) = InputCheck.check(json(actions), groups: groups ?? desktop)
		guard let failed else { return XCTFail("\(actions.prefix(120)): passed the check; want refused at \(index) as \(kind)", file: file, line: line) }
		XCTAssertEqual(failed.index, index, failed.message, file: file, line: line)
		XCTAssertEqual(failed.kind, kind, failed.message, file: file, line: line)
		XCTAssertFalse(failed.message.isEmpty, file: file, line: line)
	}

	func passes(_ actions: String, file: StaticString = #filePath, line: UInt = #line) {
		let (_, failed) = InputCheck.check(json(actions), groups: desktop)
		XCTAssertNil(failed, "\(actions): \(failed?.message ?? "")", file: file, line: line)
	}

	func batch(_ actions: String, policy: Policy = Policy(), foreground: Feature = .on) async throws -> InputActionsResult {
		try await InputBatch(platform: os.platform(foreground: foreground), policy: policy, groups: desktop, held: held).run(json(actions))
	}

	var raw: [String] { os.entries.filter { $0.hasPrefix("raw.") } }

	// MARK: the check

	func testTheCheckIsCheckActions() {
		passes("""
		[{"type":"move","at":[1,2]},{"type":"down","button":"right"},{"type":"up"},
		 {"type":"click","at":[3,4],"count":3,"keys":["shift","a"]},{"type":"drag","path":[[0,0],[5,5],[9,9]]},
		 {"type":"scroll","dy":-3,"unit":"clicks"},{"type":"scroll","dx":2.5,"unit":"px"},{"type":"key","keys":["ctrl","s"],"repeat":2},
		 {"type":"hold","keys":["alt"],"ms":100},{"type":"type","text":"anything at all, ü too\\nand a tab\\t"},{"type":"wait","ms":10}]
		""")
		passes("[]")
		passes(#"[{"type":"move","at":[100000,100000]}]"#)
		refused(#""click""#, at: 0, .invalid)
		refused("[" + Array(repeating: #"{"type":"wait","ms":0}"#, count: 101).joined(separator: ",") + "]", at: 100, .limit)
		passes("[" + Array(repeating: #"{"type":"wait","ms":0}"#, count: 100).joined(separator: ",") + "]")
		refused(#"[{"type":"click","at":[1,1]},{"type":"key","keys":["Hyper_Q"]}]"#, at: 1, .invalid)
		refused(#"[{"type":"click","at":[1,1],"keys":["Return"]}]"#, at: 0, .invalid)
		refused(#"[{"type":"key","keys":[]}]"#, at: 0, .invalid)
		refused(#"[{"type":"drag","path":[[1,1]]}]"#, at: 0, .invalid)
		refused(#"[{"type":"click","count":4}]"#, at: 0, .invalid)
		refused(#"[{"type":"move","at":[1,"2"]}]"#, at: 0, .invalid)
		refused(#"[{"type":"move","at":[1.5,2]}]"#, at: 0, .invalid)
		refused(#"[{"type":"move","at":[1,1],"speed":3}]"#, at: 0, .invalid)
		refused(#"[{"type":"teleport"}]"#, at: 0, .invalid)
		refused("[null]", at: 0, .invalid)
		refused(#"[{"type":"click","at":null}]"#, at: 0, .invalid)
		refused(#"[{"type":"wait","ms":null}]"#, at: 0, .invalid)
		refused(#"[{"type":"wait","ms":-1}]"#, at: 0, .invalid)
		refused(#"[{"type":"down","button":null}]"#, at: 0, .invalid)
		refused(#"[{"type":"scroll","dy":1.5,"unit":"clicks"}]"#, at: 0, .invalid)
		refused(#"[{"type":"scroll","dy":10001,"unit":"clicks"}]"#, at: 0, .limit)
		refused(#"[{"type":"wait","ms":1},{"type":"type","text":"bell \u0007"}]"#, at: 1, .invalid)
		refused(#"[{"type":"type","text":"a\r\n"}]"#, at: 0, .invalid)
		refused(#"[{"type":"key","keys":["a"],"repeat":101}]"#, at: 0, .limit)
		passes(#"[{"type":"key","keys":["a"],"repeat":100}]"#)
		refused(#"[{"type":"key","keys":["a"],"repeat":2.5}]"#, at: 0, .invalid)
		refused(#"[{"type":"key","keys":["a"],"repeat":101}]"#, [.screen, .inputPointer], at: 0, .unsupported)
		refused(#"[{"type":"wait","ms":299990},{"type":"hold","keys":["shift"],"ms":5},{"type":"wait","ms":6}]"#, at: 2, .limit)
		passes(#"[{"type":"wait","ms":300000}]"#)
		refused(#"[{"type":"wait","ms":1}]"#, [], at: 0, .unsupported)
		for touch in [#"{"type":"tap","at":[1,1]}"#, #"{"type":"long_press","at":[1,1]}"#, #"{"type":"swipe","path":[[1,1],[2,2]]}"#, #"{"type":"pinch","at":[1,1],"scale":2}"#, #"{"type":"button","name":"back"}"#] {
			refused("[" + touch + "]", at: 0, .unsupported)
		}
	}

	// MARK: the run

	func testAClickLandsWhereAndAsOftenAsAsked() async throws {
		let one = try await batch(#"[{"type":"click","at":[40,61]}]"#)
		XCTAssertEqual(one, InputActionsResult(done: 1))
		XCTAssertEqual(raw, ["raw.move 20,30.5", "raw.down left 20,30.5 1", "raw.up left 20,30.5 1"], "pixels are points at scale 2")
		let two = try await batch(#"[{"type":"click","at":[100,100],"count":2,"button":"right"}]"#)
		XCTAssertEqual(two, InputActionsResult(done: 1))
		XCTAssertEqual(Array(raw.dropFirst(3)), ["raw.move 50,50", "raw.down right 50,50 1", "raw.up right 50,50 1", "raw.down right 50,50 2", "raw.up right 50,50 2"])
	}

	func testKeysPressInOrderAndReleaseInReverse() async throws {
		let result = try await batch(#"[{"type":"key","keys":["ctrl","shift","s"]},{"type":"type","text":"Hi"}]"#)
		XCTAssertEqual(result, InputActionsResult(done: 2))
		XCTAssertEqual(raw, ["raw.key ctrl down", "raw.key shift down", "raw.key s down", "raw.key s up", "raw.key shift up", "raw.key ctrl up", "raw.type Hi"])
	}

	func testAClickWithKeysHoldsThemAroundIt() async throws {
		_ = try await batch(#"[{"type":"click","at":[10,10],"keys":["super"]}]"#)
		XCTAssertEqual(raw, ["raw.key super down", "raw.move 5,5", "raw.down left 5,5 1", "raw.up left 5,5 1", "raw.key super up"])
	}

	func testADragHoldsTheButtonAlongItsPath() async throws {
		let result = try await batch(#"[{"type":"drag","path":[[0,0],[40,0]]}]"#)
		XCTAssertEqual(result, InputActionsResult(done: 1))
		XCTAssertEqual(raw, ["raw.move 0,0", "raw.down left 0,0 1", "raw.move 20,0 left", "raw.up left 20,0 1"])
	}

	func testAScrollInPixelsIsInPoints() async throws {
		_ = try await batch(#"[{"type":"scroll","at":[20,20],"dy":30,"unit":"px"},{"type":"scroll","dx":-2,"unit":"clicks"}]"#)
		XCTAssertEqual(raw, ["raw.move 10,10", "raw.scroll 10,10 0 15 px", "raw.scroll 10,10 -2 0 clicks"])
	}

	func testABatchWithAnUnknownKeyRunsNothing() async throws {
		let result = try await batch(#"[{"type":"click","at":[10,10]},{"type":"key","keys":["Hyper_Q"]}]"#)
		XCTAssertEqual(result.done, 0)
		XCTAssertEqual(result.failed?.index, 1)
		XCTAssertEqual(result.failed?.kind, .invalid)
		XCTAssertEqual(raw, [])
	}

	func testABatchStopsAtItsFirstFailureAndReleasesWhatItHeld() async throws {
		let result = try await batch(#"[{"type":"move","at":[50,50]},{"type":"down","button":"left"},{"type":"key","keys":["shift"]},{"type":"move","at":[100000,100000]},{"type":"click","at":[80,80]}]"#)
		XCTAssertEqual(result.done, 3)
		XCTAssertEqual(result.failed?.index, 3)
		XCTAssertEqual(result.failed?.kind, .invalid)
		XCTAssertEqual(result.failed?.message, "action 3 (move): (100000, 100000) is outside the 2880x1800 screen")
		XCTAssertEqual(raw, ["raw.move 25,25", "raw.down left 25,25 1", "raw.key shift down", "raw.key shift up", "raw.up left 25,25 1"], "the button released where the pointer still is")
	}

	func testAFailedEventStopsTheBatchWithItsWords() async throws {
		os.with { $0.rawFails = ["raw.key s down"] }
		let result = try await batch(#"[{"type":"key","keys":["ctrl","s"]},{"type":"wait","ms":5}]"#)
		XCTAssertEqual(result.done, 0)
		XCTAssertEqual(result.failed?.kind, .invalid)
		XCTAssertEqual(result.failed?.message, "action 0 (key): the fake refused raw.key s down")
		XCTAssertEqual(raw, ["raw.key ctrl down", "raw.key ctrl up"])
	}

	func testADownWithNoUpStaysDownIntoTheNextBatch() async throws {
		_ = try await batch(#"[{"type":"move","at":[10,10]},{"type":"down"}]"#)
		XCTAssertEqual(raw, ["raw.move 5,5", "raw.down left 5,5 1"])
		_ = try await batch(#"[{"type":"up"}]"#)
		XCTAssertEqual(raw.last, "raw.up left 5,5 1")
	}

	func testAMoveAfterADownInAnEarlierBatchIsADrag() async throws {
		_ = try await batch(#"[{"type":"move","at":[10,10]},{"type":"down"}]"#)
		_ = try await batch(#"[{"type":"move","at":[20,20]}]"#)
		XCTAssertEqual(raw.last, "raw.move 10,10 left", "the button an earlier batch left down is held through the move")
	}

	func testAFailureReleasesAButtonAnEarlierBatchLeftDown() async throws {
		_ = try await batch(#"[{"type":"move","at":[10,10]},{"type":"down"}]"#)
		os.with { _ = $0.rawFails.insert("raw.key s down") }
		let result = try await batch(#"[{"type":"key","keys":["s"]}]"#)
		XCTAssertNotNil(result.failed)
		XCTAssertEqual(raw.last, "raw.up left 5,5 1", "the earlier batch's button is let go")
	}

	func testClosingTheDriverReleasesWhatABatchLeftDown() async throws {
		let driver = Driver(platform: os.platform(), policy: Policy(), machine: MachineInfo(os: "macos", osVersion: nil, device: nil))
		_ = try await driver.router().handler("input.actions")!(json(#"{"actions":[{"type":"move","at":[10,10]},{"type":"down"}]}"#))
		await driver.close()
		XCTAssertEqual(raw.last, "raw.up left 5,5 1")
	}

	/// A request cancelled mid-drag, with shift held around it: the cancelled batch still posts the key-up and the
	/// button-up (the fake, as the Mac's input queue, posts nothing for a cancelled task), and nothing stays held.
	func testACancelDuringAHeldDragLeavesNothingDown() async throws {
		os.react = { entry, _ in
			// The request is cancelled once the drag is under way: shift and the button are down.
			if entry == "raw.move 20,0 left" { withUnsafeCurrentTask { $0?.cancel() } }
		}
		let input = InputBatch(platform: os.platform(), policy: Policy(), groups: desktop, held: held)
		let actions = json(#"[{"type":"drag","path":[[0,0],[200,0]],"keys":["shift"]}]"#)
		let outcome = await Task { try await input.run(actions) }.result
		guard case .failure(let error as RPCError) = outcome else { return XCTFail("the cancelled batch answered: \(outcome)") }
		XCTAssertEqual(error.kind, .aborted)
		XCTAssertEqual(raw.prefix(4), ["raw.key shift down", "raw.move 0,0", "raw.down left 0,0 1", "raw.move 20,0 left"])
		XCTAssertEqual(raw.dropFirst(4).first, "raw.key shift up")
		XCTAssertTrue(raw.dropFirst(5).first?.hasPrefix("raw.up left") == true, "\(raw)")
		XCTAssertEqual(raw.count, 6)
		let (buttons, keys) = held.get()
		XCTAssertEqual(buttons, [], "no button is still down")
		XCTAssertEqual(keys, [], "no key is still down")
	}

	func testALongTypeIsSentInBurstsSoTheAppInFrontIsCheckedBetweenThem() async throws {
		// The first burst switches to an app the owner does not allow, as a key chord could.
		os.react = { entry, os in
			if entry.hasPrefix("raw.type ") { os.with { $0.front = "com.apple.Notes" } }
		}
		let text = String(repeating: "a", count: InputRun.typeBurstCharacters * 3)
		let result = try await batch(#"[{"type":"type","text":"\#(text)"}]"#, policy: Policy(apps: ["com.apple.Safari"]))
		XCTAssertEqual(result.failed?.kind, .denied)
		XCTAssertEqual(raw.count, 1, "only the first burst went out")
	}

	func testAPersonMovingThePointerStopsTheBatch() async throws {
		os.react = { entry, os in
			if entry == "raw.up left 10,10 1" { os.with { $0.cursor = Point(700, 300) } }
		}
		let result = try await batch(#"[{"type":"click","at":[20,20]},{"type":"key","keys":["shift"]},{"type":"click","at":[40,40]}]"#)
		XCTAssertEqual(result.done, 1)
		XCTAssertEqual(result.failed?.index, 1)
		XCTAssertEqual(result.failed?.kind, .aborted)
		XCTAssertTrue(result.failed?.message.contains("someone moved the pointer to (700, 300)") == true, result.failed?.message ?? "")
		XCTAssertEqual(raw.count, 3, "nothing after the person moved it")
	}

	/// The batch's own keys are not a person's (the fake's raw input, as Computerd's posted events, never counts): a key
	/// the person presses partway through stops the batch before its next action, in the words a ui act's stop uses.
	func testAPersonPressingAKeyStopsTheBatch() async throws {
		os.react = { entry, os in
			if entry == "raw.key a up" { os.with { $0.now += 5; $0.personPressed = $0.now } }
		}
		let result = try await batch(#"[{"type":"key","keys":["a"]},{"type":"key","keys":["b"]},{"type":"type","text":"cd"}]"#)
		XCTAssertEqual(result.done, 1)
		XCTAssertEqual(result.failed?.index, 1)
		XCTAssertEqual(result.failed?.kind, .aborted)
		XCTAssertTrue(result.failed?.message.contains("someone used the keyboard or the mouse while this batch ran") == true, result.failed?.message ?? "")
		XCTAssertTrue(result.failed?.message.contains("the person has the computer, so the batch stopped before this action and sent it nothing") == true, result.failed?.message ?? "")
		XCTAssertEqual(raw, ["raw.key a down", "raw.key a up"], "nothing after the person pressed a key")
	}

	func testAKeyPressedBeforeTheBatchBeganIsNoTakeOver() async throws {
		os.with { $0.personPressed = $0.now; $0.now += 5 }
		let result = try await batch(#"[{"type":"key","keys":["a"]},{"type":"type","text":"b"}]"#)
		XCTAssertEqual(result, InputActionsResult(done: 2))
	}

	func testRawInputLandsOnlyOnAnAppTheOwnerAllows() async throws {
		// The fake's app in front is Safari.
		let result = try await batch(#"[{"type":"key","keys":["a"]}]"#, policy: Policy(apps: ["com.apple.Notes"]))
		XCTAssertEqual(result.done, 0)
		XCTAssertEqual(result.failed?.kind, .denied)
		XCTAssertTrue(result.failed?.message.contains("the app in front, com.apple.Safari") == true, result.failed?.message ?? "")
		XCTAssertEqual(raw, [])
		let allowed = try await batch(#"[{"type":"key","keys":["a"]}]"#, policy: Policy(apps: ["com.apple.Safari"]))
		XCTAssertEqual(allowed, InputActionsResult(done: 1))
	}

	func testRawInputNeedsTheForegroundGrant() async throws {
		do {
			_ = try await batch(#"[{"type":"key","keys":["a"]}]"#, foreground: .off("Post Event is not granted to Computerd"))
			XCTFail("it ran without the grant")
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .denied)
			XCTAssertEqual(e.message, "input.actions is this computer's own keyboard and mouse, and Post Event is not granted to Computerd")
		}
		XCTAssertEqual(raw, [])
	}

	func testTheDriverServesInputActions() async throws {
		let driver = Driver(platform: os.platform(), policy: Policy(), machine: MachineInfo(os: "macos", osVersion: nil, device: nil))
		let reply = try await driver.router().handler("input.actions")!(json(#"{"actions":[{"type":"wait","ms":1}]}"#))
		XCTAssertEqual(reply, .object(["done": .int(1)]))
		let refused = try await driver.router().handler("input.actions")!(json(#"{"actions":[{"type":"tap","at":[1,1]}]}"#))
		XCTAssertEqual(refused["failed"]?["kind"], .string("unsupported"))
	}
}
