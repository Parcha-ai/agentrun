// computerd: the command line beside Computerd.app. It never holds a grant itself: it relays to the app's socket, so
// macOS judges every action by the app's signature, wherever the command was started (an SSH session in a VM, a
// terminal, a harness).
//
//   computerd [stdio]           relay stdin and stdout to the app: the computer protocol's stdio binding
//   computerd hello             print the app's hello (its features, with the reason each is off)
//   computerd pair URL TOKEN    save the attach binding's serve URL and pairing token, and restart the app to dial it
//   computerd unpair            forget them
import ComputerdKit
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

func fail(_ words: String) -> Never {
	FileHandle.standardError.write(Data("computerd: \(words)\n".utf8))
	exit(1)
}

func connectOrFail() -> Int32 {
	do {
		return try UnixSocket.connect(Paths.socket)
	} catch let error as RPCError {
		fail(error.message)
	} catch {
		fail("\(error)")
	}
}

/// Copies stdin to the socket and the socket to stdout until the app closes it. The end of stdin closes the socket's
/// write half, so replies still running come back before the relay exits.
func relay() -> Never {
	signal(SIGPIPE, SIG_IGN)
	let fd = connectOrFail()
	let input = Thread {
		var buffer = [UInt8](repeating: 0, count: 64 * 1024)
		while true {
			let n = buffer.withUnsafeMutableBytes { read(0, $0.baseAddress, $0.count) }
			if n < 0 && errno == EINTR { continue }
			if n <= 0 { break }
			if !FDOutput.writeAll(fd, Data(buffer[0..<n])) { break }
		}
		shutdown(fd, Int32(SHUT_WR))
	}
	input.start()
	var buffer = [UInt8](repeating: 0, count: 64 * 1024)
	while true {
		let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
		if n < 0 && errno == EINTR { continue }
		if n <= 0 { break }
		if !FDOutput.writeAll(1, Data(buffer[0..<n])) { break }
	}
	exit(0)
}

/// One request and its reply, printed.
func hello() -> Never {
	let fd = connectOrFail()
	_ = FDOutput.writeAll(fd, Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"client\":\"computerd-cli\"}}\n".utf8))
	var reply = Data()
	var buffer = [UInt8](repeating: 0, count: 64 * 1024)
	while !reply.contains(10) {
		let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
		if n <= 0 { break }
		reply.append(contentsOf: buffer[0..<n])
	}
	guard let line = reply.split(separator: 10).first,
		let json = try? JSONSerialization.jsonObject(with: Data(line)),
		let pretty = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
	else { fail("Computerd sent no reply") }
	FileHandle.standardOutput.write(pretty + Data("\n".utf8))
	exit(0)
}

func pair(_ url: String, _ token: String) -> Never {
	guard let parsed = URL(string: url), parsed.scheme == "wss" || parsed.scheme == "ws", parsed.host != nil else {
		fail("\(url) is not a wss:// URL")
	}
	let settings = AttachSettings(url: url, token: token)
	do {
		try settings.save()
	} catch {
		fail("cannot save \(Paths.attach): \(error)")
	}
	restartApp()
	print("paired: Computerd dials \(url)")
	exit(0)
}

func unpair() -> Never {
	try? FileManager.default.removeItem(atPath: Paths.attach)
	restartApp()
	print("unpaired")
	exit(0)
}

/// Restarts the LaunchAgent, so the app reads its settings again.
func restartApp() {
	#if os(macOS)
	let task = Process()
	task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
	task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(AttachSettings.agentLabel)"]
	try? task.run()
	task.waitUntilExit()
	#endif
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case nil, "stdio": relay()
case "hello": hello()
case "pair":
	guard args.count == 3 else { fail("usage: computerd pair wss://<serve>/v2/computers/attach <pairing token>") }
	pair(args[1], args[2])
case "unpair": unpair()
case "-h", "--help", "help":
	print("usage: computerd [stdio] | hello | pair URL TOKEN | unpair")
	exit(0)
default:
	fail("unknown command \(args[0]): computerd [stdio] | hello | pair URL TOKEN | unpair")
}
