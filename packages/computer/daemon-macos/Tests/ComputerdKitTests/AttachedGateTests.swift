import Foundation
import XCTest
@testable import ComputerdKit

/// An attached connection (Computerd dialed the server it is paired with) offers exec, files, tar and the whole screen
/// only by the Mac's owner's grant in policy.json ("server"); hello says so, and every call is checked whatever hello
/// said. The socket (stdio, over SSH or a local harness) is the Mac's own user's and offers them as before.
final class AttachedGateTests: XCTestCase {
	var os: FakeOS!
	var dir: String!

	override func setUp() {
		os = FakeOS()
		dir = NSTemporaryDirectory() + "attached-gate-" + UUID().uuidString
		try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		FileManager.default.createFile(atPath: dir + "/note.txt", contents: Data("hi".utf8))
	}

	override func tearDown() {
		try? FileManager.default.removeItem(atPath: dir)
	}

	func driver(_ policy: Policy, _ caller: Caller) -> Driver {
		Driver(platform: os.platform(), policy: policy, caller: caller, machine: MachineInfo(os: "macos", osVersion: nil, device: nil))
	}

	/// One call of each method the grants gate, with the grant it needs.
	var calls: [(method: String, grant: ServerGrant, params: JSON)] {
		[
			("exec.run", .exec, .object(["argv": .array([.string("/bin/echo"), .string("hi")]), "timeoutMs": .int(10_000)])),
			("files.stat", .files, .object(["path": .string(dir + "/note.txt")])),
			("files.read", .files, .object(["path": .string(dir + "/note.txt")])),
			("tar.pull.begin", .files, .object(["path": .string(dir)])),
			("screen.shot", .screen, .object([:])),
			("screen.watch", .screen, .object(["after": .int(0), "waitMs": .int(0)])),
		]
	}

	/// The refusal's words, or a failure when the call was not refused `denied`.
	func refusal(_ body: () async throws -> JSON, _ what: String, file: StaticString = #filePath, line: UInt = #line) async -> String? {
		do {
			_ = try await body()
			XCTFail("\(what) was not refused", file: file, line: line)
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .denied, "\(what): \(e.message)", file: file, line: line)
			return e.message
		} catch {
			XCTFail("\(what): \(error)", file: file, line: line)
		}
		return nil
	}

	func testTheWordsSayWhoCanSwitchItOnAndWhere() {
		let words = Policy.ungranted(.exec)
		XCTAssertTrue(words.hasPrefix("running programs (exec) is off for the server this Mac is paired with: only this Mac's owner can switch it on"), words)
		XCTAssertTrue(words.contains("adding \"exec\" to \"server\" in "), words)
		XCTAssertTrue(words.contains("Computerd/policy.json"), words)
		XCTAssertTrue(Policy.ungranted(.files).contains("(files, tar)"))
		XCTAssertTrue(Policy.ungranted(.screen).contains("(screen.shot, screen.watch)"))
	}

	func testAnAttachedConnectionWithoutTheGrantIsRefusedEachCallInWords() async throws {
		let d = driver(Policy(), .attached)
		let r = d.router()
		for call in calls {
			let words = await refusal({ try await r.handler(call.method)!(call.params) }, call.method)
			XCTAssertEqual(words, Policy.ungranted(call.grant), call.method)
		}
		// Refused before its params are read: a call that would not even parse gets the same words.
		let bad = await refusal({ try await r.handler("exec.run")!(.object(["nonsense": .bool(true)])) }, "exec.run with bad params")
		XCTAssertEqual(bad, Policy.ungranted(.exec))
		let read = await refusal({ try await r.handler("screen.read")!(.object(["id": .string("s1"), "offset": .int(0)])) }, "screen.read")
		XCTAssertEqual(read, Policy.ungranted(.screen))
		XCTAssertEqual(os.entries, [], "nothing ran")
		await d.close()
	}

	func testHelloOnAnAttachedConnectionOffersNoneOfThemWithoutTheGrant() {
		let hello = driver(Policy(), .attached).hello()
		XCTAssertEqual(hello.groups, [.screen, .inputPointer, .inputKeys, .apps, .ui], "no exec, no files; the screen group stays, since a desktop needs it")
		XCTAssertEqual(hello.features?[FeatureName.screenCapture], .off(Policy.ungranted(.screen)))
		XCTAssertEqual(hello.features?[FeatureName.image], .on, "a window's image is the app policy's, not the screen's")
	}

	func testTheOwnersGrantTurnsEachBackOn() async throws {
		let d = driver(Policy(server: [.exec, .files, .screen]), .attached)
		let r = d.router()
		for call in calls { _ = try await r.handler(call.method)!(call.params) }
		let ran = try await r.handler("exec.run")!(calls[0].params)
		XCTAssertEqual(ran["exitCode"], .int(0))
		let hello = d.hello()
		XCTAssertEqual(hello.groups, Driver.groups)
		XCTAssertEqual(hello.features?[FeatureName.screenCapture], .on)
		await d.close()
	}

	func testAGrantTurnsOnOnlyItsOwn() async throws {
		let d = driver(Policy(server: [.files]), .attached)
		let r = d.router()
		for call in calls {
			if call.grant == .files {
				_ = try await r.handler(call.method)!(call.params)
			} else {
				let words = await refusal({ try await r.handler(call.method)!(call.params) }, call.method)
				XCTAssertEqual(words, Policy.ungranted(call.grant), call.method)
			}
		}
		XCTAssertEqual(d.hello().groups, [.files, .screen, .inputPointer, .inputKeys, .apps, .ui])
		await d.close()
	}

	func testTheSocketOffersThemWithNoGrant() async throws {
		let d = driver(Policy(), .local)
		let r = d.router()
		for call in calls { _ = try await r.handler(call.method)!(call.params) }
		let hello = d.hello()
		XCTAssertEqual(hello.groups, Driver.groups)
		XCTAssertEqual(hello.features?[FeatureName.screenCapture], .on)
		await d.close()
	}

	func testWithoutScreenRecordingTheScreenIsOffForItsOwnReason() {
		os.screenRecording = false
		XCTAssertEqual(driver(Policy(), .local).hello().features?[FeatureName.screenCapture], .off("Screen Recording is not granted to Computerd"))
		XCTAssertEqual(driver(Policy(server: [.screen]), .attached).hello().features?[FeatureName.screenCapture], .off("Screen Recording is not granted to Computerd"))
	}

	func testThePolicyFileNamesTheGrant() throws {
		let path = dir + "/policy.json"
		func load(_ text: String) throws -> Policy {
			FileManager.default.createFile(atPath: path, contents: Data(text.utf8))
			return try Policy.load(path)
		}
		XCTAssertEqual(try load(#"{"apps": ["com.apple.TextEdit"], "server": ["exec", "screen"]}"#), Policy(apps: ["com.apple.TextEdit"], server: [.exec, .screen]))
		XCTAssertNil(try load(#"{"apps": ["com.apple.TextEdit"]}"#).server, "absent: none")
		XCTAssertThrowsError(try load(#"{"server": ["shell"]}"#), "a grant it does not know makes the file no policy, which grants nothing")
		XCTAssertEqual(try Policy.load(dir + "/none.json"), Policy(), "no file: any app, and nothing for the server")
	}
}
