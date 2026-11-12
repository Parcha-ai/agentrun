import Foundation
import XCTest
@testable import ComputerdKit

/// The JSON-RPC connection: strict params, method not found, parse errors, the line limit, cancels, replies in any order.
final class WireTests: XCTestCase {
	struct Echo: Codable, Sendable, Equatable {
		var text: String
		var n: Int?
	}

	func router() -> Router {
		var r = Router()
		r.onAny("hello") { Empty() }
		r.on("echo", Echo.self) { $0 }
		r.on("sleep", Empty.self) { _ in
			try await Task.sleep(nanoseconds: 30_000_000_000)
			return Empty()
		}
		r.on("big", Empty.self) { _ in String(repeating: "x", count: 2048) }
		return r
	}

	/// Serves lines, keeps the input open until `replies` replies came (or 2 s passed), then ends it and answers them.
	/// Ending the input cancels what still runs, as wire.md says.
	func serve(_ lines: [Line], replies: Int = 1, maxLineBytes: Int = Limits.maxLineBytes) async -> [JSON] {
		let out = Lines()
		let connection = Connection(router: router(), output: out, maxLineBytes: maxLineBytes)
		let (stream, input) = AsyncStream<Line>.makeStream()
		let served = Task { await connection.serve(stream) }
		for line in lines { input.yield(line) }
		for _ in 0..<200 where await out.json().count < replies {
			try? await Task.sleep(nanoseconds: 10_000_000)
		}
		input.finish()
		await served.value
		return await out.json()
	}

	func line(_ s: String) -> Line { .data(Data(s.utf8)) }

	func error(_ reply: JSON?) -> (Int64?, String?) {
		guard case .int(let code)? = reply?["error"]?["code"] else { return (nil, nil) }
		return (code, reply?["error"]?["data"]?["kind"]?.stringValue)
	}

	func testEchoesAResult() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi","n":2}}"#)])
		XCTAssertEqual(replies.first?["result"], .object(["text": .string("hi"), "n": .int(2)]))
		XCTAssertEqual(replies.first?["id"], .int(1))
	}

	func testUnknownFieldIsInvalid() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":"a","method":"echo","params":{"text":"hi","extra":1}}"#)])
		XCTAssertEqual(error(replies.first).0, -32602)
		XCTAssertEqual(error(replies.first).1, "invalid")
		XCTAssertTrue(replies.first?["error"]?["message"]?.stringValue?.contains("params.extra") == true)
		XCTAssertEqual(replies.first?["id"], .string("a"))
	}

	func testNullFieldIsRefusedWithWords() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi","n":null}}"#)])
		XCTAssertTrue(replies.first?["error"]?["message"]?.stringValue?.contains("is null") == true)
	}

	func testWrongTypeNamesTheField() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":5}}"#)])
		XCTAssertEqual(error(replies.first).0, -32602)
		XCTAssertTrue(replies.first?["error"]?["message"]?.stringValue?.contains("params.text") == true)
	}

	func testHelloTakesAnyParams() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"x","new":true}}"#)])
		XCTAssertEqual(replies.first?["result"], .object([:]))
	}

	func testMethodNotFound() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"nope"}"#)])
		XCTAssertEqual(error(replies.first).0, -32601)
		XCTAssertEqual(error(replies.first).1, "unsupported")
	}

	func testParseErrorHasNullID() async {
		let replies = await serve([line("{not json")])
		XCTAssertEqual(error(replies.first).0, -32700)
		XCTAssertEqual(replies.first?["id"], .null)
	}

	func testBlankLinesAndNotificationsGetNoReply() async {
		let replies = await serve([line("   "), line(#"{"jsonrpc":"2.0","method":"echo","params":{"text":"x"}}"#)], replies: 0)
		XCTAssertEqual(replies, [])
	}

	func testLineOverTheLimitKeepsItsID() async {
		let replies = await serve([.tooLong(prefix: Data(#"{"jsonrpc":"2.0","id":42,"method":"files.write","params":{"data":"AAAA"#.utf8))])
		XCTAssertEqual(error(replies.first).0, -32600)
		XCTAssertEqual(error(replies.first).1, "limit")
		XCTAssertEqual(replies.first?["id"], .int(42))
	}

	func testSplitterMarksALongLine() {
		var splitter = LineSplitter(maxLineBytes: 8)
		let lines = splitter.feed(Data("short\nthis line is long\nok\n".utf8))
		XCTAssertEqual(lines.count, 3)
		XCTAssertEqual(lines[0], .data(Data("short".utf8)))
		if case .tooLong = lines[1] {} else { XCTFail("the long line is marked") }
		XCTAssertEqual(lines[2], .data(Data("ok".utf8)))
	}

	func testReplyOverTheLimitIsALimitError() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"big"}"#)], maxLineBytes: 1024)
		XCTAssertEqual(error(replies.first).1, "limit")
	}

	func testCancelAbortsTheRequest() async throws {
		let out = Lines()
		let connection = Connection(router: router(), output: out)
		let (stream, input) = AsyncStream<Line>.makeStream()
		let served = Task { await connection.serve(stream) }
		input.yield(line(#"{"jsonrpc":"2.0","id":7,"method":"sleep"}"#))
		input.yield(line(#"{"jsonrpc":"2.0","id":8,"method":"echo","params":{"text":"after"}}"#))
		input.yield(line(#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":7}}"#))
		var replies: [JSON] = []
		for _ in 0..<200 {
			replies = await out.json()
			if replies.count == 2 { break }
			try await Task.sleep(nanoseconds: 10_000_000)
		}
		input.finish()
		await served.value
		let cancelled = replies.first { $0["id"] == .int(7) }
		XCTAssertEqual(error(cancelled).0, -32800)
		XCTAssertEqual(error(cancelled).1, "aborted")
		// The echo, sent after the sleep, answered without waiting for it.
		XCTAssertEqual(replies.first { $0["id"] == .int(8) }?["result"]?["text"], .string("after"))
	}

	func testEndOfInputCancelsWhatRuns() async {
		let replies = await serve([line(#"{"jsonrpc":"2.0","id":1,"method":"sleep"}"#)], replies: 0)
		XCTAssertEqual(error(replies.first).1, "aborted")
	}

	func testLeadingID() {
		XCTAssertEqual(Connection.leadingID(Data(#"{"id": "abc", "x"#.utf8)), .string("abc"))
		XCTAssertEqual(Connection.leadingID(Data(#"{"jsonrpc":"2.0","id":-3,"#.utf8)), .int(-3))
		XCTAssertEqual(Connection.leadingID(Data(#"{"method":"x""#.utf8)), .null)
	}
}
