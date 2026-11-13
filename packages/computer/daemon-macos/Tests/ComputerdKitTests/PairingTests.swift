import Foundation
import XCTest
@testable import ComputerdKit
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Pairing as the agent runs it (Pairer), and the local control call the command line and the window hand it over.
final class PairingTests: XCTestCase {
	var dir: String!
	let hello = HelloResult(os: "macos", osVersion: nil, kind: "desktop", arch: "arm64", groups: [], screen: nil, features: nil, device: nil)

	override func setUpWithError() throws {
		dir = NSTemporaryDirectory() + "pairing-\(UUID().uuidString.prefix(8))"
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	}

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(atPath: dir)
	}

	func pairer(status: Int = 201, body: Data? = nil, keep: @escaping @Sendable (String, String) throws -> Void = { _, _ in }) -> Pairer {
		let answer = body ?? (try! Coders.encode(PairResult(computer: "cmp_1", token: "tok_1")))
		return Pairer(post: { _, _ in (status, answer) }, keep: keep, settingsPath: dir + "/attach.json")
	}

	func error(_ body: () async throws -> some Any) async -> RPCError? {
		do {
			_ = try await body()
			XCTFail("it did not throw")
		} catch let e as RPCError {
			return e
		} catch {
			XCTFail("\(error)")
		}
		return nil
	}

	func testAPairKeepsTheTokenAndTheServer() async throws {
		let kept = Box()
		let p = pairer(keep: { token, computer in kept.set("\(computer) \(token)") })
		let settings = try await p.pair(PairParams(server: "https://agentrun.example/", code: "k7pd-w3qx"), name: "vesper-mac", hello: hello)
		XCTAssertEqual(settings, AttachSettings(server: "https://agentrun.example", computer: "cmp_1"))
		XCTAssertEqual(kept.value, "cmp_1 tok_1")
		XCTAssertEqual(AttachSettings.load(dir + "/attach.json"), settings)
	}

	func testATokenThatCannotBeKeptAfterTheServerPairedSaysWhatToDo() async throws {
		let p = pairer(keep: { _, _ in throw RPCError.denied("the keychain refused the token: User interaction is not allowed.") })
		let e = await error { try await p.pair(PairParams(server: "https://agentrun.example", code: "K7PD-W3QX"), name: "vesper-mac", hello: hello) }
		XCTAssertEqual(e?.kind, .denied)
		let words = e?.message ?? ""
		XCTAssertTrue(words.contains("https://agentrun.example paired this Mac as vesper-mac"), words)
		XCTAssertTrue(words.contains("could not be kept (the keychain refused the token: User interaction is not allowed.)"), words)
		XCTAssertTrue(words.hasSuffix("remove vesper-mac in the console's Computers page and pair again"), words)
		XCTAssertFalse(words.contains("tok_1"), "the words never hold the token")
		XCTAssertNil(AttachSettings.load(dir + "/attach.json"), "no server is kept without its token")
	}

	func testTheNameGivenIsTheOneToRemove() async throws {
		let p = pairer(status: 200, keep: { _, _ in throw RPCError.denied("no keychain") })
		let e = await error { try await p.pair(PairParams(server: "https://agentrun.example", code: "K7PD-W3QX", name: "Studio"), name: "vesper-mac", hello: hello) }
		XCTAssertTrue(e?.message.hasSuffix("remove Studio in the console's Computers page and pair again") ?? false, e?.message ?? "")
	}

	func testARefusedCodeKeepsNothing() async throws {
		let p = pairer(status: 404, body: Data(#"{"error":{"message":"no such pairing code"}}"#.utf8), keep: { _, _ in XCTFail("kept a token for a refused code") })
		let e = await error { try await p.pair(PairParams(server: "https://agentrun.example", code: "K7PD-W3QX"), name: "vesper-mac", hello: hello) }
		XCTAssertEqual(e?.kind, .denied)
		XCTAssertEqual(e?.message, "https://agentrun.example refused the code (404): no such pairing code")
		XCTAssertNil(AttachSettings.load(dir + "/attach.json"))
	}

	func testACodeOutOfTheAlphabetIsNeverSent() async throws {
		let p = Pairer(post: { _, _ in XCTFail("posted a code that is not one"); return (201, Data()) }, keep: { _, _ in }, settingsPath: dir + "/attach.json")
		let e = await error { try await p.pair(PairParams(server: "https://agentrun.example", code: "K7PD-W3Q0"), name: "vesper-mac", hello: hello) }
		XCTAssertEqual(e?.kind, .invalid)
	}

	func testTheControlCallsAreNeverADriverMethod() {
		let driver = Driver(platform: FakeOS().platform(), policy: Policy(), caller: .attached, machine: MachineInfo(os: "macos", osVersion: nil, device: nil))
		let methods = driver.router().methods
		XCTAssertFalse(methods.contains(Control.pair), "attach serves the driver's router: pairing is the socket's only")
		XCTAssertFalse(methods.contains(Control.unpair))
		XCTAssertFalse(methods.contains { $0.hasPrefix("computerd.") })
	}

	func testALocalCallAnswersTheResultOrTheErrorOfItsKind() async throws {
		let path = dir + "/s.sock"
		let listener = try UnixSocket.listen(path)
		defer { close(listener) }
		var router = Router()
		router.on(Control.pair, PairParams.self) { p in
			if p.code == "bad" { throw RPCError.denied("refused the code") }
			return AttachSettings(server: p.server, computer: "cmp_1")
		}
		let served = router
		let thread = Thread {
			while let fd = UnixSocket.accept(listener) {
				Task {
					await Connection(router: served, output: FDOutput(fd: fd)).serve(FDLines.read(fd: fd))
					close(fd)
				}
			}
		}
		thread.start()
		let ok = try await Task.detached { try LocalCall.call(Control.pair, try Coders.json(PairParams(server: "https://a.example", code: "K7PD-W3QX")), path: path) }.value
		XCTAssertEqual(ok["computer"], .string("cmp_1"))
		do {
			_ = try await Task.detached { try LocalCall.call(Control.pair, try Coders.json(PairParams(server: "https://a.example", code: "bad")), path: path) }.value
			XCTFail("it did not throw")
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .denied)
			XCTAssertEqual(e.message, "refused the code")
		}
	}
}

final class Box: @unchecked Sendable {
	private let lock = NSLock()
	private var stored: String?
	var value: String? { lock.withLock { stored } }
	func set(_ v: String) { lock.withLock { stored = v } }
}
