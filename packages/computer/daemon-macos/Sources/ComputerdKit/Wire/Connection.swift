import Foundation

/// One line read from a connection: whole, or over the line limit (only its start is kept, to find its id).
public enum Line: Sendable, Equatable {
	case data(Data)
	case tooLong(prefix: Data)
}

/// Where a connection's replies go: a pipe, a socket, a WebSocket. Writes are whole lines.
public protocol LineOutput: Sendable {
	func send(_ line: Data) async
}

/// The notification that cancels a request by id (as in LSP).
public let cancelMethod = "$/cancelRequest"

/// Serves one connection: JSON-RPC lines in, replies out. Requests run at once and reply in any order; a caller matches
/// replies by id. When the input ends, every request still running is cancelled.
public final class Connection: Sendable {
	let router: Router
	let output: LineOutput
	let maxLineBytes: Int
	let inflight = Inflight()

	public init(router: Router, output: LineOutput, maxLineBytes: Int = Limits.maxLineBytes) {
		self.router = router
		self.output = output
		self.maxLineBytes = maxLineBytes
	}

	public func serve<S: AsyncSequence & Sendable>(_ lines: S) async where S.Element == Line {
		do {
			for try await line in lines {
				await take(line)
			}
		} catch {
			// A read error ends the input, as its end does.
		}
		await inflight.cancelAll()
	}

	func take(_ line: Line) async {
		switch line {
		case .tooLong(let prefix):
			await reply(id: Self.leadingID(prefix), error: RPCError(.limit, "a request line holds at most \(maxLineBytes) bytes", code: RPCCode.invalidRequest))
		case .data(let data):
			let trimmed = data.last == 13 ? data.dropLast() : data[...]
			if trimmed.allSatisfy({ $0 == 32 || $0 == 9 }) { return }
			guard let message = try? Coders.decoder().decode(JSON.self, from: Data(trimmed)) else {
				await reply(id: .null, error: RPCError(.invalid, "the line is not JSON", code: RPCCode.parse))
				return
			}
			await dispatch(message)
		}
	}

	func dispatch(_ message: JSON) async {
		guard case .object(let fields) = message else {
			await reply(id: .null, error: RPCError(.invalid, "a request is a JSON object", code: RPCCode.invalidRequest))
			return
		}
		let id = fields["id"]
		guard case .string(let method)? = fields["method"] else {
			await reply(id: id ?? .null, error: RPCError(.invalid, "a request names its method", code: RPCCode.invalidRequest))
			return
		}
		guard let id, id != .null else {
			// A notification: only a cancel means anything.
			if method == cancelMethod, let target = fields["params"]?["id"] {
				await inflight.cancel(Self.key(target))
			}
			return
		}
		guard let handler = router.handler(method) else {
			await reply(id: id, error: RPCError(.unsupported, "this computer has no method \(method)", code: RPCCode.methodNotFound))
			return
		}
		let params = fields["params"]
		let key = Self.key(id)
		await inflight.start(key) { [self] token in
			let outcome: Result<JSON, RPCError>
			do {
				let result = try await handler(params)
				outcome = Task.isCancelled ? .failure(.aborted) : .success(result)
			} catch let error as RPCError {
				outcome = .failure(error)
			} catch is CancellationError {
				outcome = .failure(.aborted)
			} catch {
				outcome = .failure(RPCError(.invalid, "\(method) failed: \(error)"))
			}
			// The request stays tracked until its reply is sent, so the input ending cannot close the socket under it.
			switch outcome {
			case .success(let result): await reply(id: id, result: result)
			case .failure(let error): await reply(id: id, error: error)
			}
			await inflight.remove(key, token)
		}
	}

	func reply(id: JSON, result: JSON) async {
		let line = Self.encode(.object(["jsonrpc": .string("2.0"), "id": id, "result": result]))
		if line.count > maxLineBytes {
			await reply(id: id, error: RPCError(.limit, "the reply would be over \(maxLineBytes) bytes"))
			return
		}
		await output.send(line)
	}

	func reply(id: JSON, error: RPCError) async {
		let body: JSON = .object([
			"code": .int(Int64(error.rpcCode)),
			"message": .string(error.message),
			"data": .object(["kind": .string(error.kind.rawValue)]),
		])
		await output.send(Self.encode(.object(["jsonrpc": .string("2.0"), "id": id, "error": body])))
	}

	static func encode(_ value: JSON) -> Data {
		(try? Coders.encode(value)) ?? Data("{}".utf8)
	}

	/// A request's id as a map key: its JSON.
	static func key(_ id: JSON) -> String {
		String(decoding: encode(id), as: UTF8.self)
	}

	/// The id of a line over the limit, when it can be read from the line's start: `"id":` then a number or a string.
	static func leadingID(_ prefix: Data) -> JSON {
		let text = String(decoding: prefix, as: UTF8.self)
		guard let range = text.range(of: "\"id\"") else { return .null }
		var rest = text[range.upperBound...].drop(while: { $0 == " " || $0 == "\t" })
		guard rest.first == ":" else { return .null }
		rest = rest.dropFirst().drop(while: { $0 == " " || $0 == "\t" })
		if rest.first == "\"" {
			let body = rest.dropFirst()
			guard let end = body.firstIndex(of: "\"") else { return .null }
			return .string(String(body[..<end]))
		}
		let digits = rest.prefix(while: { $0 == "-" || $0.isNumber })
		if let n = Int64(digits) { return .int(n) }
		return .null
	}
}

/// The requests running on a connection, by id, so a cancel can reach them.
actor Inflight {
	var tasks: [String: (token: Int, task: Task<Void, Never>)] = [:]
	var counter = 0
	/// Tasks that were replaced under their id (a caller reused it) and have not finished: cancelAll waits for them too.
	var replaced: [Int: Task<Void, Never>] = [:]

	/// Starts a request's task and holds it, in one step on the actor, so the task's own remove always comes after.
	/// The body gets its token: only the task that holds an id removes it.
	func start(_ key: String, _ body: @escaping @Sendable (Int) async -> Void) {
		counter += 1
		let token = counter
		if let old = tasks[key] { replaced[old.token] = old.task }
		tasks[key] = (token, Task { await body(token) })
	}

	func remove(_ key: String, _ token: Int) {
		if tasks[key]?.token == token { tasks[key] = nil }
		replaced[token] = nil
	}

	func cancel(_ key: String) {
		tasks[key]?.task.cancel()
	}

	func cancelAll() async {
		let running = tasks.values.map(\.task) + Array(replaced.values)
		for task in running { task.cancel() }
		for task in running { await task.value }
	}
}
