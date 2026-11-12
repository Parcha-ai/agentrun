// computerd: the command line beside Computerd.app. It never holds a grant itself: it relays to the app's socket, so
// macOS judges every action by the app's signature, wherever the command was started (an SSH session in a VM, a
// terminal, a harness).
//
//   computerd [stdio]                  relay stdin and stdout to the app: the computer protocol's stdio binding
//   computerd hello                    print the app's hello (its features, with the reason each is off)
//   computerd pair SERVER CODE [NAME]  pair this Mac with a server, by the code its console shows, so the app dials it
//   computerd unpair                   forget the server and the token
//
// Pairing runs in the app's own executable, so the token it puts in the keychain is the app's to read.
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

/// The app's executable: $COMPUTERD_APP, else Contents/MacOS/Computerd of the bundle this command sits in
/// (Contents/Helpers/computerd), through any symlink to it.
func appExecutable() -> String {
	if let given = ProcessInfo.processInfo.environment["COMPUTERD_APP"], !given.isEmpty { return given }
	var me = URL(fileURLWithPath: CommandLine.arguments[0])
	#if canImport(Darwin)
	var size: UInt32 = 4096
	var buffer = [CChar](repeating: 0, count: Int(size))
	if _NSGetExecutablePath(&buffer, &size) == 0 {
		me = URL(fileURLWithPath: String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self))
	}
	#endif
	let contents = me.resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
	return contents.appendingPathComponent("MacOS/Computerd").path
}

/// Runs the app's executable with these arguments and exits with its status.
func runApp(_ arguments: [String]) -> Never {
	let path = appExecutable()
	guard FileManager.default.isExecutableFile(atPath: path) else {
		fail("cannot find Computerd.app's executable at \(path): run the computerd inside Computerd.app/Contents/Helpers")
	}
	let task = Process()
	task.executableURL = URL(fileURLWithPath: path)
	task.arguments = arguments
	do {
		try task.run()
	} catch {
		fail("cannot run \(path): \(error)")
	}
	task.waitUntilExit()
	exit(task.terminationStatus)
}

let usage = "usage: computerd [stdio] | hello | pair SERVER CODE [NAME] | unpair"
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case nil, "stdio": relay()
case "hello": hello()
case "pair":
	guard args.count == 3 || args.count == 4 else { fail("usage: computerd pair https://<server> <code from its console> [a name for this Mac]") }
	runApp(["--pair"] + args.dropFirst())
case "unpair": runApp(["--unpair"])
case "-h", "--help", "help":
	print(usage)
	exit(0)
default:
	fail("unknown command \(args[0]): \(usage)")
}
