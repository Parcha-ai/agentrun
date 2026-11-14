// Computerd.app: the computer protocol's driver in the user's login session. It holds every grant (Accessibility,
// Screen Recording, Post Event), serves its unix socket to the computerd command, and dials the server it is paired
// with. It runs as a LaunchAgent in the Aqua session, with AppKit's main thread, and shows a window only to ask for
// grants and to pair.
//
//   Computerd                       run (the LaunchAgent starts it so)
//   Computerd --until-granted       the grants window, closing once every grant is on
//
// Pairing is the computerd command's (Helpers/computerd pair, unpair); it calls the running agent.
#if os(macOS)
import AppKit
import ComputerdKit
import ComputerdMac
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case nil, "--until-granted":
	break
default:
	FileHandle.standardError.write(Data("Computerd: unknown argument \(arguments[0])\n".utf8))
	exit(1)
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
