import Foundation
import XCTest
@testable import ComputerdKit

/// The Swift types against spec/computer: every sample of every method's params and result validates against
/// methods.schema.json, the samples together use every field the schema names, and the constants equal protocol.json's.
/// So the Swift mirror cannot drift from protocol.ts without a red test.
final class SchemaTests: XCTestCase {
	/// spec/computer, or COMPUTERD_SPEC_DIR.
	static var specDir: URL {
		if let dir = ProcessInfo.processInfo.environment["COMPUTERD_SPEC_DIR"] { return URL(fileURLWithPath: dir) }
		// Tests/ComputerdKitTests/SchemaTests.swift -> the repo's root.
		var url = URL(fileURLWithPath: #filePath)
		for _ in 0..<6 { url.deleteLastPathComponent() }
		return url.appendingPathComponent("spec/computer")
	}

	static func load(_ name: String) throws -> JSON {
		let url = specDir.appendingPathComponent(name)
		return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
	}

	/// Fields the schema names that this driver never sends, and why.
	static let notSent: [String: Set<String>] = [
		// A desktop under X11 and init's network fence: Linux computers only.
		"hello.result": ["display", "fence"],
	]

	struct Case {
		let method: String
		let params: [any Encodable]
		let results: [any Encodable]
	}

	static let data = Data("hello".utf8)

	static var cases: [Case] {
		let point = Point(3, 4)
		let rect = Rect(1, 2, 3, 4)
		let stat = FileStat(type: .symlink, size: 5, mode: 0o644, mtimeMs: 1, uid: 501, gid: 20, target: "/tmp/x")
		return [
			Case(method: "hello", params: [HelloParams(client: "computerd 0.2.0")], results: [
				HelloResult(os: "macos", osVersion: "26.1", kind: "desktop", arch: "arm64", groups: Driver.groups, screen: ScreenInfo(width: 1512, height: 982, scale: 2), features: ["ui.tree": .on, "ui.image": .on, "ui.nav": .off("no")], device: Device(maker: "Apple", model: "MacBook Pro")),
				HelloResult(os: "macos", osVersion: nil, kind: "desktop", arch: "arm64", groups: [], screen: nil, features: nil, device: nil),
			]),
			Case(method: "ping", params: [Empty()], results: [Empty()]),
			Case(method: "exec.run", params: [
				ExecRunParams(argv: ["ls"], cwd: "/", env: ["A": "b"], user: "me", timeoutMs: 1000, maxOutput: 10),
				ExecRunParams(argv: ["ls"], timeoutMs: 1),
			], results: [
				ExecRunResult(exitCode: 0, signal: "SIGTERM", stdout: data, stderr: data, timedOut: true, truncated: true),
				ExecRunResult(exitCode: nil, stdout: Data(), stderr: Data(), timedOut: false, truncated: false),
			]),
			Case(method: "files.read", params: [
				FilesReadParams(path: "/a", offset: 1, length: 2), FilesReadParams(path: "/a"),
			], results: [FilesReadResult(data: data, eof: true, size: 5)]),
			Case(method: "files.write", params: [
				FilesWriteParams(path: "/a", data: data, offset: 1, append: nil, mode: 0o600, parents: true),
				FilesWriteParams(path: "/a", data: data, append: true),
			], results: [FilesWriteResult(size: 5)]),
			Case(method: "files.stat", params: [FilesStatParams(path: "/a", follow: true), FilesStatParams(path: "/a")], results: [
				stat, FileStat(type: .file, size: 1, mode: 0o644, mtimeMs: 1, uid: 0, gid: 0, target: nil),
			]),
			Case(method: "files.list", params: [FilesListParams(path: "/a", depth: 2, offset: 3), FilesListParams(path: "/a")], results: [
				FilesListResult(entries: [FileEntry(path: "/a/b", stat)], truncated: true),
			]),
			Case(method: "files.mkdir", params: [FilesMkdirParams(path: "/a", parents: true, mode: 0o700), FilesMkdirParams(path: "/a")], results: [Empty()]),
			Case(method: "files.move", params: [FilesMoveParams(from: "/a", to: "/b", overwrite: true), FilesMoveParams(from: "/a", to: "/b")], results: [Empty()]),
			Case(method: "files.remove", params: [FilesRemoveParams(path: "/a", recursive: true), FilesRemoveParams(path: "/a")], results: [Empty()]),
			Case(method: "tar.pull.begin", params: [TarPathParams(path: "/a")], results: [TarIDResult(id: "pull1")]),
			Case(method: "tar.pull.read", params: [TarPullReadParams(id: "pull1", maxBytes: 10), TarPullReadParams(id: "pull1")], results: [TarPullReadResult(data: data, eof: false)]),
			Case(method: "tar.pull.end", params: [TarIDParams(id: "pull1")], results: [Empty()]),
			Case(method: "tar.push.begin", params: [TarPathParams(path: "/a")], results: [TarIDResult(id: "push1")]),
			Case(method: "tar.push.write", params: [TarPushWriteParams(id: "push1", data: data)], results: [Empty()]),
			Case(method: "tar.push.end", params: [TarIDParams(id: "push1")], results: [TarPushEndResult(entries: 3)]),
			Case(method: "screen.shot", params: [ScreenShotParams(region: rect), ScreenShotParams(region: nil)], results: [
				ScreenShotResult(id: "img1", size: 5, data: data, eof: true, width: 10, height: 10, scale: 2, cursor: point),
				ScreenShotResult(id: "img1", size: 5, data: data, eof: true, width: 10, height: 10, scale: 2, cursor: nil),
			]),
			Case(method: "screen.read", params: [ScreenReadParams(id: "img1", offset: 0)], results: [ScreenReadResult(data: data, eof: true)]),
			Case(method: "screen.watch", params: [ScreenWatchParams(after: 0, waitMs: 1, maxWidth: 100, quality: 50), ScreenWatchParams(after: 0)], results: [
				ScreenWatchResult(seq: 1, changed: true, id: "img1", size: 5, data: data, eof: true, format: "jpeg", frameWidth: 10, frameHeight: 10, width: 20, height: 20, cursor: point),
				ScreenWatchResult(seq: 1, changed: false, width: 20, height: 20),
			]),
			Case(method: "apps.list", params: [Empty()], results: [
				AppsListResult(apps: [App(id: "a", name: "A", version: "1")], foreground: "a"), AppsListResult(apps: [App(id: "a")], foreground: nil),
			]),
			Case(method: "apps.launch", params: [AppsLaunchParams(id: "a", url: "https://x", background: true), AppsLaunchParams(id: "a")], results: [Empty()]),
			Case(method: "apps.terminate", params: [AppsTerminateParams(id: "a")], results: [Empty()]),
			Case(method: "ui.observe", params: [
				UiObserveParams(target: Target(app: "a", window: "1"), full: true, image: .image(maxEdge: 800), since: "s1"),
				UiObserveParams(image: .image(maxEdge: nil)), UiObserveParams(image: ImageOption.none), UiObserveParams(),
			], results: [
				UiObserveResult(state: "s2", app: UiApp(id: "a", name: "A", pid: 4), window: UiWindow(id: "1", title: "T", bounds: rect), nodes: [
					UiNode(ref: "@e1", role: "button", name: "OK", value: "v", desc: "d", id: "ok", bounds: rect, parent: "@e0", flags: UiFlag.allCases, actions: ["AXPress"]),
				], diff: UiDiff(added: ["@e1"], removed: [], changed: []), image: UiImage(format: "png", width: 1, height: 1, data: data), truncated: false),
				UiObserveResult(state: "s2", app: UiApp(id: "a", name: "A", pid: 4), window: UiWindow(id: "1", title: "T", bounds: rect), nodes: [], image: UiImage(format: "jpeg", width: 1, height: 1, data: data), empty: "ui.tree is off here", truncated: false),
				UiObserveResult(state: "s2", app: UiApp(id: "a", name: "A", pid: nil), window: UiWindow(id: "1", title: nil, bounds: rect), nodes: [UiNode(ref: "@e1", role: "generic", bounds: rect)], diff: nil, image: nil, truncated: true),
			]),
			Case(method: "ui.act", params: [
				UiActParams(target: Target(app: "a", window: "1"), state: "s1", steps: [
					.press("@e1"), .set("@e1", value: "x"), .perform("@e1", action: "AXShowMenu"),
					.click(.ref("@e1"), button: .right, count: 2), .click(.point(point), button: nil, count: nil),
					.type("hi", into: "@e2"), .type("hi", into: nil), .key("super+s"), .nav(.appSwitch),
					.scroll(.ref("@e1"), dx: 1, dy: 2), .scroll(.point(point), dx: nil, dy: nil),
					.drag([point, point], ms: 100), .drag([point, point], ms: nil),
				], expect: Expect(text: "Saved", ref: "@e1", gone: true, timeoutMs: 100), foreground: true),
				UiActParams(steps: [], expect: Expect(text: "x")),
			], results: [
				UiActResult(steps: [.ran(route: .background, verified: true), .error(StepError(kind: .stale, message: "gone"))], state: "s3", changed: true, expect: .met),
				UiActResult(steps: [], state: "s3", changed: false, expect: nil),
			]),
		]
	}

	func testEverySampleValidatesAndCoversTheSchema() throws {
		let schema = try Self.load("schema/methods.schema.json")
		let validator = SchemaValidator(definitions: schema["definitions"]?.objectValue ?? [:])
		guard let methods = schema["definitions"]?["DaemonMethods"]?["properties"]?.objectValue else {
			return XCTFail("methods.schema.json has no DaemonMethods")
		}
		let served = Set(Driver(platform: FakeOS().platform(), policy: Policy(), machine: MachineInfo(os: "macos", osVersion: nil, device: nil)).router().methods)
		let tested = Set(Self.cases.map(\.method))
		XCTAssertEqual(served, tested, "every method the driver serves has samples here")
		for method in served {
			XCTAssertNotNil(methods[method], "\(method) is in DaemonMethods")
		}
		for c in Self.cases {
			guard let spec = methods[c.method] else { continue }
			for (side, samples) in [("params", c.params), ("result", c.results)] {
				guard let ref = spec["properties"]?[side] else { XCTFail("\(c.method) has no \(side)"); continue }
				var seen = KeyPaths()
				for sample in samples {
					let json = try Coders.json(AnyEncodable(sample))
					for problem in validator.validate(json, ref, at: "\(c.method).\(side)") { XCTFail(problem) }
					seen.collect(json, at: "\(c.method).\(side)")
				}
				for missing in validator.fields(ref, at: "\(c.method).\(side)") where !seen.paths.contains(missing) {
					let parent = String(missing[..<missing.lastIndex(of: ".")!])
					let field = String(missing[missing.index(after: missing.lastIndex(of: ".")!)...])
					if Self.notSent[parent]?.contains(field) == true { continue }
					XCTFail("the schema has \(missing), which no Swift sample sends: the Swift type lacks it")
				}
			}
		}
	}

	func testConstantsEqualProtocolJSON() throws {
		let p = try Self.load("protocol.json")
		XCTAssertEqual(p["protocolVersion"], .string(protocolVersion))
		let limits = p["limits"]?.objectValue ?? [:]
		let ours: [String: Int] = [
			"maxLineBytes": Limits.maxLineBytes, "maxOutputBytes": Limits.maxOutputBytes, "maxChunkBytes": Limits.maxChunkBytes,
			"maxListDepth": Limits.maxListDepth, "maxListEntries": Limits.maxListEntries, "maxBatchWaitMs": Limits.maxBatchWaitMs,
			"maxUiNodes": Limits.maxUiNodes, "maxSteps": Limits.maxSteps, "maxExpectMs": Limits.maxExpectMs,
			"defaultExpectMs": Limits.defaultExpectMs, "maxSettleMs": Limits.maxSettleMs, "minImageEdge": Limits.minImageEdge,
			"maxImageEdge": Limits.maxImageEdge, "defaultImageEdge": Limits.defaultImageEdge,
		]
		for (name, value) in ours { XCTAssertEqual(limits[name], .int(Int64(value)), name) }
		XCTAssertEqual(p["keys"], .array(keyNames.map(JSON.string)))
		XCTAssertEqual(p["uiRoles"], .array(uiRoles.map(JSON.string)))
		XCTAssertEqual(Set(p["uiFlags"]?.arrayStrings ?? []), Set(UiFlag.allCases.map(\.rawValue)))
		XCTAssertEqual(Set(p["errorKinds"]?.arrayStrings ?? []), Set(ErrorKind.allCases.map(\.rawValue)))
		XCTAssertEqual(Set(p["features"]?.objectValue?.keys.map { $0 } ?? []), Set(FeatureName.all))
		let groups = Set(p["groups"]?.arrayStrings ?? [])
		for g in Group.allCases { XCTAssertTrue(groups.contains(g.rawValue), g.rawValue) }
		XCTAssertEqual(p["jsonrpc"]?["cancelMethod"], .string(cancelMethod))
		let codes = p["jsonrpc"]?["codes"]?.objectValue ?? [:]
		XCTAssertEqual(codes["parse"], .int(Int64(RPCCode.parse)))
		XCTAssertEqual(codes["invalidRequest"], .int(Int64(RPCCode.invalidRequest)))
		XCTAssertEqual(codes["methodNotFound"], .int(Int64(RPCCode.methodNotFound)))
		XCTAssertEqual(codes["invalidParams"], .int(Int64(RPCCode.invalidParams)))
		XCTAssertEqual(codes["server"], .int(Int64(RPCCode.server)))
		XCTAssertEqual(codes["requestCancelled"], .int(Int64(RPCCode.requestCancelled)))
	}

	/// The validator itself refuses what it should, so a green drift test means something.
	func testValidatorRefuses() throws {
		let schema = try Self.load("schema/methods.schema.json")
		let validator = SchemaValidator(definitions: schema["definitions"]?.objectValue ?? [:])
		let ref = JSON.object(["$ref": .string("#/definitions/UiActParams")])
		XCTAssertFalse(validator.validate(.object(["steps": .array([]), "extra": .bool(true)]), ref, at: "x").isEmpty)
		XCTAssertFalse(validator.validate(.object(["steps": .array([.object(["press": .int(1)])])]), ref, at: "x").isEmpty)
		XCTAssertFalse(validator.validate(.object([:]), ref, at: "x").isEmpty)
		XCTAssertTrue(validator.validate(.object(["steps": .array([.object(["key": .string("enter")])])]), ref, at: "x").isEmpty)
	}
}

extension JSON {
	var arrayStrings: [String]? {
		if case .array(let a) = self { return a.compactMap(\.stringValue) }
		return nil
	}
}

struct AnyEncodable: Encodable {
	let value: any Encodable
	init(_ value: any Encodable) { self.value = value }
	func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// Every object key path in some JSON, with array items as one path.
struct KeyPaths {
	var paths = Set<String>()

	mutating func collect(_ json: JSON, at path: String) {
		switch json {
		case .object(let o):
			for (k, v) in o {
				paths.insert("\(path).\(k)")
				collect(v, at: "\(path).\(k)")
			}
		case .array(let a):
			for v in a { collect(v, at: path + "[]") }
		default: break
		}
	}
}

/// The JSON Schema draft-07 subset methods.schema.json uses: $ref, type, properties, required, additionalProperties,
/// items (one schema, or a tuple), minItems, maxItems, enum, const and anyOf.
struct SchemaValidator {
	let definitions: [String: JSON]

	func resolve(_ schema: JSON) -> JSON {
		if let ref = schema["$ref"]?.stringValue, ref.hasPrefix("#/definitions/") {
			return resolve(definitions[String(ref.dropFirst("#/definitions/".count))] ?? .object([:]))
		}
		return schema
	}

	func validate(_ value: JSON, _ raw: JSON, at path: String) -> [String] {
		let schema = resolve(raw)
		if let options = schema["anyOf"], case .array(let list) = options {
			let fits = list.contains { validate(value, $0, at: path).isEmpty }
			return fits ? [] : ["\(path): \(Self.show(value)) matches none of anyOf"]
		}
		var problems: [String] = []
		if let c = schema["const"], c != value { problems.append("\(path): \(Self.show(value)) is not \(Self.show(c))") }
		if case .array(let allowed)? = schema["enum"], !allowed.contains(value) {
			problems.append("\(path): \(Self.show(value)) is not one of \(Self.show(.array(allowed)))")
		}
		if let type = schema["type"] {
			let types: [String] = type.arrayStrings ?? [type.stringValue ?? ""]
			if !types.contains(where: { Self.fits(value, $0) }) {
				problems.append("\(path): \(Self.show(value)) is not \(types.joined(separator: " or "))")
				return problems
			}
		}
		switch value {
		case .object(let o):
			let props = schema["properties"]?.objectValue ?? [:]
			for name in schema["required"]?.arrayStrings ?? [] where o[name] == nil {
				problems.append("\(path).\(name) is required")
			}
			for (k, v) in o {
				if let p = props[k] {
					problems += validate(v, p, at: "\(path).\(k)")
				} else if let extra = schema["additionalProperties"] {
					if extra == .bool(false) {
						problems.append("\(path).\(k) is not in the schema")
					} else if case .object = extra {
						problems += validate(v, extra, at: "\(path).\(k)")
					}
				}
			}
		case .array(let a):
			if case .int(let min)? = schema["minItems"], a.count < min { problems.append("\(path) has fewer than \(min) items") }
			if case .int(let max)? = schema["maxItems"], a.count > max { problems.append("\(path) has more than \(max) items") }
			if case .array(let tuple)? = schema["items"] {
				for (i, (v, s)) in zip(a, tuple).enumerated() { problems += validate(v, s, at: "\(path)[\(i)]") }
			} else if let items = schema["items"] {
				for (i, v) in a.enumerated() { problems += validate(v, items, at: "\(path)[\(i)]") }
			}
		default: break
		}
		return problems
	}

	static func fits(_ value: JSON, _ type: String) -> Bool {
		switch (type, value) {
		case ("null", .null), ("boolean", .bool), ("string", .string), ("array", .array), ("object", .object): return true
		case ("integer", .int), ("number", .int), ("number", .double): return true
		case ("integer", .double(let d)): return d == d.rounded()
		default: return false
		}
	}

	/// Every field path the schema names under a ref, through objects, arrays and anyOf, as KeyPaths writes them.
	func fields(_ raw: JSON, at path: String, depth: Int = 0) -> Set<String> {
		guard depth < 8 else { return [] }
		let schema = resolve(raw)
		var out = Set<String>()
		if case .array(let list)? = schema["anyOf"] {
			for s in list { out.formUnion(fields(s, at: path, depth: depth + 1)) }
		}
		for (k, v) in schema["properties"]?.objectValue ?? [:] {
			out.insert("\(path).\(k)")
			out.formUnion(fields(v, at: "\(path).\(k)", depth: depth + 1))
		}
		if let items = schema["items"], case .object = items {
			out.formUnion(fields(items, at: path + "[]", depth: depth + 1))
		}
		return out
	}

	static func show(_ json: JSON) -> String {
		String(decoding: (try? Coders.encode(json)) ?? Data(), as: UTF8.self)
	}
}
