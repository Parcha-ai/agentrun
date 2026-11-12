// Computerd.app: the computer protocol's driver in the user's login session. It holds every grant (Accessibility,
// Screen Recording, Post Event), serves its unix socket to the computerd command, and dials the server it is paired
// with. It runs as a LaunchAgent in the Aqua session, with AppKit's main thread, and shows a window only to ask for
// grants and to pair.
//
//   Computerd                       run (the LaunchAgent starts it so)
//   Computerd --pair SERVER CODE [NAME]
//   Computerd --unpair
//   Computerd --until-granted       the grants window, closing once every grant is on
//   Computerd --register-agent      register the LaunchAgent for this build (unregistering first)
//   Computerd --unregister-agent
#if os(macOS)
import AppKit
import ComputerdKit
import ComputerdMac
import Foundation

func fail(_ words: String) -> Never {
	FileHandle.standardError.write(Data("Computerd: \(words)\n".utf8))
	exit(1)
}

/// Restarts the LaunchAgent, so the app dials with its new settings.
func restartAgent() {
	let task = Process()
	task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
	task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(AttachSettings.agentLabel)"]
	try? task.run()
	task.waitUntilExit()
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "--pair":
	guard arguments.count == 3 || arguments.count == 4 else { fail("usage: computerd pair https://<server> <code> [name]") }
	Task {
		do {
			let settings = try await Pairing.pair(server: arguments[1], code: arguments[2], name: arguments.count == 4 ? arguments[3] : nil)
			restartAgent()
			print("paired with \(settings.server) as computer \(settings.computer)")
			exit(0)
		} catch let error as RPCError {
			fail(error.message)
		} catch {
			fail("\(error.localizedDescription)")
		}
	}
	dispatchMain()
case "--unpair":
	Pairing.unpair()
	restartAgent()
	print("unpaired")
	exit(0)
case "--register-agent":
	// Registers the LaunchAgent for this build, unregistering first: what a new self-signed build needs before its agent
	// can launch. Run it through open (open -W Computerd.app --args --register-agent) so it starts in the login session.
	// Exits 0 when the agent is enabled, 2 when a person must allow it in Login Items, 1 otherwise.
	Task {
		let status = await Agent.register(force: true)
		print("the LaunchAgent is \(Agent.name(status))")
		exit(status == .enabled ? 0 : status == .requiresApproval ? 2 : 1)
	}
	dispatchMain()
case "--unregister-agent":
	Task {
		let status = await Agent.unregister()
		print("the LaunchAgent is \(Agent.name(status))")
		exit(status == .notRegistered || status == .notFound ? 0 : 1)
	}
	dispatchMain()
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
