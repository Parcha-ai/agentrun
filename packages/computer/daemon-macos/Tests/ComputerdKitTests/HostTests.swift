import Foundation
import XCTest
@testable import ComputerdKit

/// exec.run, files.* and tar.*, against a scratch directory, with the Go daemon's rules and error kinds.
final class HostTests: XCTestCase {
	var dir = ""

	override func setUpWithError() throws {
		dir = NSTemporaryDirectory() + "computerd-test-" + UUID().uuidString
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	}

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(atPath: dir)
	}

	func kind(_ body: () throws -> Void) -> ErrorKind? {
		do {
			try body()
			return nil
		} catch let e as RPCError {
			return e.kind
		} catch {
			return nil
		}
	}

	func testWriteReadAppendAndOffsets() throws {
		let path = dir + "/a.txt"
		XCTAssertEqual(try Files.writeFile(FilesWriteParams(path: path, data: Data("hello".utf8))).size, 5)
		XCTAssertEqual(try Files.writeFile(FilesWriteParams(path: path, data: Data(" world".utf8), append: true)).size, 11)
		XCTAssertEqual(try Files.writeFile(FilesWriteParams(path: path, data: Data("J".utf8), offset: 0)).size, 11)
		let all = try Files.readFile(FilesReadParams(path: path))
		XCTAssertEqual(String(decoding: all.data, as: UTF8.self), "Jello world")
		XCTAssertTrue(all.eof)
		let part = try Files.readFile(FilesReadParams(path: path, offset: 6, length: 3))
		XCTAssertEqual(String(decoding: part.data, as: UTF8.self), "wor")
		XCTAssertFalse(part.eof)
		XCTAssertEqual(try Files.statPath(FilesStatParams(path: path)).mode, 0o644)
		XCTAssertEqual(kind { _ = try Files.writeFile(FilesWriteParams(path: path, data: Data(), offset: 1, append: true)) }, .invalid)
		XCTAssertEqual(kind { _ = try Files.readFile(FilesReadParams(path: path, length: Limits.maxChunkBytes + 1)) }, .limit)
	}

	func testErrorKinds() throws {
		XCTAssertEqual(kind { _ = try Files.readFile(FilesReadParams(path: self.dir + "/none")) }, .notFound)
		XCTAssertEqual(kind { _ = try Files.readFile(FilesReadParams(path: self.dir)) }, .isDir)
		XCTAssertEqual(kind { _ = try Files.readFile(FilesReadParams(path: "relative")) }, .invalid)
		XCTAssertEqual(kind { _ = try Files.writeFile(FilesWriteParams(path: self.dir + "/x/y", data: Data())) }, .notFound)
		XCTAssertNoThrow(try Files.writeFile(FilesWriteParams(path: dir + "/x/y", data: Data(), parents: true)))
		XCTAssertEqual(kind { try Files.removePath(FilesRemoveParams(path: self.dir + "/x")) }, .isDir)
		XCTAssertEqual(kind { try Files.removePath(FilesRemoveParams(path: "/")) }, .denied)
		XCTAssertNoThrow(try Files.removePath(FilesRemoveParams(path: dir + "/x", recursive: true)))
		XCTAssertEqual(kind { try Files.makeDir(FilesMkdirParams(path: self.dir)) }, .exists)
		XCTAssertNoThrow(try Files.makeDir(FilesMkdirParams(path: dir, parents: true)))
		XCTAssertEqual(kind { _ = try Files.writeFile(FilesWriteParams(path: self.dir + "/m", data: Data(), mode: 0o17777)) }, .invalid)
	}

	func testCleanPaths() throws {
		XCTAssertEqual(try Files.clean("path", "/a/./b/../c//d/"), "/a/c/d")
		XCTAssertEqual(try Files.clean("path", "/.."), "/")
	}

	func testMoveRefusesToClobber() throws {
		let a = dir + "/a"
		let b = dir + "/b"
		_ = try Files.writeFile(FilesWriteParams(path: a, data: Data("a".utf8)))
		_ = try Files.writeFile(FilesWriteParams(path: b, data: Data("b".utf8)))
		XCTAssertEqual(kind { try Files.movePath(FilesMoveParams(from: a, to: b)) }, .exists)
		try Files.movePath(FilesMoveParams(from: a, to: b, overwrite: true))
		XCTAssertEqual(String(decoding: try Files.readFile(FilesReadParams(path: b)).data, as: UTF8.self), "a")
		try Files.makeDir(FilesMkdirParams(path: dir + "/d"))
		XCTAssertEqual(kind { try Files.movePath(FilesMoveParams(from: self.dir + "/d", to: self.dir + "/d/e")) }, .invalid)
	}

	func testListWalksInOrderWithOffsets() throws {
		try Files.makeDir(FilesMkdirParams(path: dir + "/b/c", parents: true))
		_ = try Files.writeFile(FilesWriteParams(path: dir + "/a", data: Data()))
		_ = try Files.writeFile(FilesWriteParams(path: dir + "/b/c/f", data: Data()))
		let one = try Files.listDir(FilesListParams(path: dir))
		XCTAssertEqual(one.entries.map(\.path), [dir + "/a", dir + "/b"])
		let deep = try Files.listDir(FilesListParams(path: dir, depth: 3))
		XCTAssertEqual(deep.entries.map(\.path), [dir + "/a", dir + "/b", dir + "/b/c", dir + "/b/c/f"])
		let rest = try Files.listDir(FilesListParams(path: dir, depth: 3, offset: 2))
		XCTAssertEqual(rest.entries.map(\.path), [dir + "/b/c", dir + "/b/c/f"])
		XCTAssertEqual(kind { _ = try Files.listDir(FilesListParams(path: self.dir, depth: 17)) }, .invalid)
		XCTAssertEqual(kind { _ = try Files.listDir(FilesListParams(path: self.dir + "/a")) }, .notDir)
	}

	func testExecRunsArgvNotAShell() async throws {
		let r = try await Exec.run(ExecRunParams(argv: ["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], cwd: dir, timeoutMs: 10_000))
		XCTAssertEqual(r.exitCode, 3)
		XCTAssertEqual(String(decoding: r.stdout, as: UTF8.self), "out\n")
		XCTAssertEqual(String(decoding: r.stderr, as: UTF8.self), "err\n")
		XCTAssertFalse(r.timedOut)
		let pwd = try await Exec.run(ExecRunParams(argv: ["pwd"], cwd: dir, timeoutMs: 10_000))
		XCTAssertTrue(String(decoding: pwd.stdout, as: UTF8.self).hasSuffix(dir.split(separator: "/").last! + "\n"))
	}

	func testExecEnvTimeoutAndLimits() async throws {
		let env = try await Exec.run(ExecRunParams(argv: ["/bin/sh", "-c", "echo $FOO"], env: ["FOO": "bar"], timeoutMs: 10_000))
		XCTAssertEqual(String(decoding: env.stdout, as: UTF8.self), "bar\n")
		let slow = try await Exec.run(ExecRunParams(argv: ["sleep", "30"], timeoutMs: 200))
		XCTAssertTrue(slow.timedOut)
		XCTAssertEqual(slow.signal, "TERM", "a signal's name without SIG, as the Go daemon says it")
		let big = try await Exec.run(ExecRunParams(argv: ["/bin/sh", "-c", "head -c 5000 /dev/zero"], timeoutMs: 10_000, maxOutput: 100))
		XCTAssertEqual(big.stdout.count, 100)
		XCTAssertTrue(big.truncated)
		do {
			_ = try await Exec.run(ExecRunParams(argv: ["no-such-program-here"], timeoutMs: 1000))
			XCTFail("it ran")
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .notFound)
		}
		do {
			_ = try await Exec.run(ExecRunParams(argv: ["ls"], user: "someone-else", timeoutMs: 1000))
			XCTFail("it ran")
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .denied)
		}
	}

	func testTarPullThenPushRoundTrips() async throws {
		try Files.makeDir(FilesMkdirParams(path: dir + "/src/sub", parents: true))
		_ = try Files.writeFile(FilesWriteParams(path: dir + "/src/a.txt", data: Data("alpha".utf8)))
		_ = try Files.writeFile(FilesWriteParams(path: dir + "/src/sub/b.txt", data: Data("beta".utf8)))
		let tar = TarSessions(tar: FileManager.default.isExecutableFile(atPath: "/usr/bin/tar") ? "/usr/bin/tar" : "/bin/tar")
		let pull = try await tar.pullBegin(TarPathParams(path: dir + "/src"))
		var archive = Data()
		while true {
			let chunk = try await tar.pullRead(TarPullReadParams(id: pull.id, maxBytes: 700))
			archive.append(chunk.data)
			if chunk.eof { break }
		}
		XCTAssertGreaterThan(archive.count, 1024)
		let push = try await tar.pushBegin(TarPathParams(path: dir + "/dst"))
		var offset = 0
		while offset < archive.count {
			let end = min(archive.count, offset + 333)
			try await tar.pushWrite(TarPushWriteParams(id: push.id, data: archive.subdata(in: offset..<end)))
			offset = end
		}
		let done = try await tar.pushEnd(TarIDParams(id: push.id))
		XCTAssertEqual(done.entries, 3, "a.txt, sub and sub/b.txt")
		XCTAssertEqual(String(decoding: try Files.readFile(FilesReadParams(path: dir + "/dst/sub/b.txt")).data, as: UTF8.self), "beta")
	}

	func testTarEmptyDirectoryAndUnknownIDs() async throws {
		try Files.makeDir(FilesMkdirParams(path: dir + "/empty"))
		let tar = TarSessions()
		let pull = try await tar.pullBegin(TarPathParams(path: dir + "/empty"))
		let chunk = try await tar.pullRead(TarPullReadParams(id: pull.id))
		XCTAssertEqual(chunk.data, Data(count: 1024))
		XCTAssertTrue(chunk.eof)
		do {
			_ = try await tar.pullRead(TarPullReadParams(id: "pull99"))
			XCTFail("it read")
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, .notFound)
		}
	}

	func testTarCounterSkipsExtendedHeaders() {
		func header(_ type: Character, size: Int) -> Data {
			var block = [UInt8](repeating: 0, count: 512)
			let field = Array(String(size, radix: 8).utf8)
			for (i, b) in field.enumerated() { block[124 + i] = b }
			block[156] = UInt8(ascii: type.unicodeScalars.first!)
			block[0] = UInt8(ascii: "x")
			return Data(block)
		}
		var counter = TarCounter()
		counter.feed(header("x", size: 30) + Data(count: 512))
		counter.feed(header("0", size: 600) + Data(count: 1024))
		counter.feed(header("5", size: 0))
		counter.feed(Data(count: 1024))
		counter.feed(header("0", size: 0))
		XCTAssertEqual(counter.entries, 2)
	}
}
