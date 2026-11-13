// Computerd.app: the computer protocol's driver in the user's login session. It holds every grant (Accessibility,
// Screen Recording, Post Event), serves its unix socket to the computerd command, and dials the server it is paired
// with. It runs as a LaunchAgent in the Aqua session, with AppKit's main thread, and shows a window only to ask for
// grants and to pair.
//
//   Computerd                       run (the LaunchAgent starts it so)
//   Computerd --pair SERVER CODE [NAME]   hands the server and code to the running agent, which pairs
//   Computerd --unpair
//   Computerd --until-granted       the grants window, closing once every grant is on
#if os(macOS)
import AppKit
import ComputerdKit
import ComputerdMac
import Foundation

func fail(_ words: String) -> Never {
	FileHandle.standardError.write(Data("Computerd: \(words)\n".utf8))
	exit(1)
}

/// One control call to the agent, which pairs in the login session and owns the keychain (Control).
func control(_ method: String, _ params: JSON?) -> JSON {
	do {
		return try LocalCall.call(method, params)
	} catch let error as RPCError {
		fail(error.message)
	} catch {
		fail("\(error)")
	}
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "--pair":
	guard arguments.count == 3 || arguments.count == 4 else { fail("usage: computerd pair https://<server> <code> [name]") }
	let params = PairParams(server: arguments[1], code: arguments[2], name: arguments.count == 4 ? arguments[3] : nil)
	let reply = control(Control.pair, try? Coders.json(params))
	print("paired with \(reply["server"]?.stringValue ?? "?") as computer \(reply["computer"]?.stringValue ?? "?")")
	exit(0)
case "--unpair":
	_ = control(Control.unpair, .object([:]))
	print("unpaired")
	exit(0)
case "--version":
	print("Computerd \(driverVersion) (protocol \(protocolVersion))")
	exit(0)
case nil, "--until-granted":
	break
default:
	fail("unknown argument \(arguments[0])")
}

signal(SIGPIPE, SIG_IGN)
// The process's first thread is the main thread: AppKit and the app delegate live there.
MainActor.assumeIsolated {
	let app = NSApplication.shared
	let delegate = AppDelegate()
	app.delegate = delegate
	app.setActivationPolicy(.accessory)
	app.run()
}
#else
print("Computerd.app runs on macOS only")
#endif
