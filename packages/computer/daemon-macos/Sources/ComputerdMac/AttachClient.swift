#if os(macOS)
import ComputerdKit
import Foundation

/// The attach binding's driver side: dials the server, answers its calls over text frames, pings every 20 s, and
/// dials again after a drop, unless the close needs a person (pair again, update).
public final class AttachClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
	let settings: AttachSettings
	let token: String
	let makeDriver: @Sendable () -> Driver
	let onStatus: @Sendable (String) -> Void
	private var session: URLSession!
	private let lock = NSLock()
	private var closes: [Int: Int] = [:]

	public init(settings: AttachSettings, token: String, makeDriver: @escaping @Sendable () -> Driver, onStatus: @escaping @Sendable (String) -> Void) {
		self.settings = settings
		self.token = token
		self.makeDriver = makeDriver
		self.onStatus = onStatus
		super.init()
		session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
	}

	private var stopped = false
	private var current: URLSessionWebSocketTask?

	public func start() {
		Task { await self.run() }
	}

	/// Closes the socket (1001) and dials no more.
	public func stop() {
		lock.lock()
		stopped = true
		let task = current
		lock.unlock()
		task?.cancel(with: .goingAway, reason: nil)
	}

	var isStopped: Bool {
		lock.lock()
		defer { lock.unlock() }
		return stopped
	}

	func run() async {
		var attempt = 0
		while !isStopped {
			let started = Date()
			let code = await dialOnce()
			if isStopped { return }
			if let why = Attach.stop(code) {
				log("attach: stopped (\(code)): \(why)")
				onStatus("Stopped: \(why)")
				return
			}
			if Date().timeIntervalSince(started) * 1000 >= Double(Attach.steadyMs) { attempt = 0 }
			let delay = Attach.redialDelayMs(attempt)
			attempt += 1
			log("attach: closed (\(code)), dialing again in \(delay) ms")
			onStatus("Offline: dialing \(settings.server) again in \(max(1, delay / 1000)) s")
			try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
		}
	}

	/// One socket, from dial to close; answers its close code (1006 when it closed without one).
	func dialOnce() async -> Int {
		let url: URL
		do {
			url = try settings.attachURL()
		} catch {
			log("attach: \(error)")
			return Attach.Close.mismatch
		}
		var request = URLRequest(url: url)
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		request.setValue(Attach.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
		let task = session.webSocketTask(with: request)
		task.maximumMessageSize = Limits.maxLineBytes
		lock.withLock { current = task }
		task.resume()

		let driver = makeDriver()
		let connection = Connection(router: driver.router(), output: WebSocketOutput(task: task))
		let heard = Heard()
		let (lines, input) = AsyncStream<Line>.makeStream()
		let reader = Task {
			reading: while true {
				let message: URLSessionWebSocketTask.Message
				do {
					message = try await task.receive()
				} catch {
					break reading
				}
				heard.now()
				switch message {
				case .string(let text):
					input.yield(.data(Data(text.utf8)))
				case .data:
					task.cancel(with: .unsupportedData, reason: nil)
					break reading
				@unknown default:
					break reading
				}
			}
			input.finish()
		}
		let pinger = Task {
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: UInt64(Attach.heartbeatMs) * 1_000_000)
				if Task.isCancelled { return }
				if heard.ms() > Double(Attach.idleMs) {
					log("attach: nothing heard for \(Attach.idleMs / 1000) s")
					task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: Attach.Close.idle) ?? .goingAway, reason: nil)
					return
				}
				task.sendPing { error in if error == nil { heard.now() } }
			}
		}
		await connection.serve(lines)
		pinger.cancel()
		reader.cancel()
		await driver.close()
		if task.state == .running { task.cancel(with: .goingAway, reason: nil) }
		return closeCode(task)
	}

	func closeCode(_ task: URLSessionWebSocketTask) -> Int {
		if let http = task.response as? HTTPURLResponse, http.statusCode != 101 {
			switch http.statusCode {
			case 401, 403: return Attach.Close.unauthorized
			case 426: return Attach.Close.protocol
			default: return 1006
			}
		}
		lock.lock()
		let seen = closes.removeValue(forKey: task.taskIdentifier)
		lock.unlock()
		if let seen, seen != 0 { return seen }
		let code = task.closeCode.rawValue
		return code == 0 ? 1006 : code
	}

	public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol chosen: String?) {
		guard chosen == Attach.subprotocol else {
			log("attach: the server chose the subprotocol \(chosen ?? "none"), not \(Attach.subprotocol)")
			webSocketTask.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: Attach.Close.protocol) ?? .protocolError, reason: nil)
			return
		}
		log("attach: up to \(settings.server) as computer \(settings.computer)")
		onStatus("Attached to \(settings.server)")
	}

	public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
		lock.lock()
		closes[webSocketTask.taskIdentifier] = closeCode.rawValue
		lock.unlock()
	}
}

/// When anything (a message, a pong) last came in.
final class Heard: @unchecked Sendable {
	private let lock = NSLock()
	private var at = Date()

	func now() {
		lock.lock()
		at = Date()
		lock.unlock()
	}

	func ms() -> Double {
		lock.lock()
		defer { lock.unlock() }
		return Date().timeIntervalSince(at) * 1000
	}
}

/// Replies as text frames, one message each, with no newline.
actor WebSocketOutput: LineOutput {
	let task: URLSessionWebSocketTask

	init(task: URLSessionWebSocketTask) {
		self.task = task
	}

	func send(_ line: Data) async {
		try? await task.send(.string(String(decoding: line, as: UTF8.self)))
	}
}
#endif
