#if os(macOS)
import ComputerdKit
import ComputerdMac
import Foundation

/// The LaunchAgent: a plain user agent at ~/Library/LaunchAgents/ai.parcha.computerd.plist that runs this app's own
/// executable in the Aqua session, at login, and again whenever it ends. The app writes it and loads it with launchctl,
/// for every build. (Not SMAppService: an agent registered through it carries a launch constraint, which for a
/// self-signed build names the build that registered, so launchd killed every rebuild at spawn, and unregistering and
/// registering again kept the old constraint.) macOS lists the agent under Login Items & Extensions.
enum Agent {
	static let label = AttachSettings.agentLabel
	static var plistPath: String { NSHomeDirectory() + "/Library/LaunchAgents/\(label).plist" }
	static var domain: String { "gui/\(getuid())" }

	/// The agent's job, for the executable at this path. scripts/mini-bootstrap.sh writes the same keys.
	static func job(executable: String) -> NSDictionary {
		[
			"Label": label,
			"ProgramArguments": [executable],
			// Login Items & Extensions shows the agent as Computerd, with its icon, rather than as a bare plist.
			"AssociatedBundleIdentifiers": [Bundle.main.bundleIdentifier ?? label],
			"EnvironmentVariables": ["COMPUTERD_SERVE": "1"],
			"LimitLoadToSessionType": "Aqua",
			"RunAtLoad": true,
			"KeepAlive": true,
			"ProcessType": "Interactive",
		]
	}

	/// launchctl, with its output; its exit status.
	@discardableResult
	static func launchctl(_ arguments: [String]) -> (status: Int32, output: String) {
		let task = Process()
		task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
		task.arguments = arguments
		let pipe = Pipe()
		task.standardOutput = pipe
		task.standardError = pipe
		do { try task.run() } catch { return (-1, "\(error)") }
		let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
		task.waitUntilExit()
		return (task.terminationStatus, output.trimmingCharacters(in: .whitespacesAndNewlines))
	}

	/// launchd has the job loaded.
	static var loaded: Bool { launchctl(["print", "\(domain)/\(label)"]).status == 0 }

	/// Writes the plist for this app's executable, boots out any job with the label, and bootstraps it. Nothing to do
	/// when the plist already runs this executable and the job is loaded. Answers why it failed, or nil.
	@discardableResult
	static func install() -> String? {
		guard let executable = Bundle.main.executablePath else { return failed("no executable path for the LaunchAgent") }
		let wanted = job(executable: executable)
		let data: Data
		do {
			data = try PropertyListSerialization.data(fromPropertyList: wanted, format: .xml, options: 0)
		} catch {
			return failed("cannot write the LaunchAgent's plist: \(error)")
		}
		let now = FileManager.default.contents(atPath: plistPath).flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? NSDictionary }
		if now == wanted && loaded {
			log("the LaunchAgent runs \(executable) already")
			return nil
		}
		do {
			try FileManager.default.createDirectory(atPath: (plistPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
			try data.write(to: URL(fileURLWithPath: plistPath), options: .atomic)
		} catch {
			return failed("cannot write \(plistPath): \(error)")
		}
		launchctl(["bootout", "\(domain)/\(label)"])
		// A job just booted out can take a moment to go: bootstrap is asked again for up to 2 s.
		var last = (status: Int32(0), output: "")
		for _ in 0..<5 {
			last = launchctl(["bootstrap", domain, plistPath])
			if last.status == 0 {
				log("the LaunchAgent is loaded: \(plistPath) runs \(executable)")
				return nil
			}
			Thread.sleep(forTimeInterval: 0.4)
		}
		return failed("launchctl bootstrap \(domain) \(plistPath) failed (\(last.status)): \(last.output)")
	}

	/// Boots the job out and deletes its plist: Computerd no longer runs at login.
	static func remove() {
		launchctl(["bootout", "\(domain)/\(label)"])
		try? FileManager.default.removeItem(atPath: plistPath)
		log("the LaunchAgent is removed")
	}

	/// Logs why the agent could not be set up, and answers it.
	static func failed(_ words: String) -> String {
		log(words)
		return words
	}

	static var state: String {
		guard FileManager.default.fileExists(atPath: plistPath) else { return "Not installed" }
		return loaded ? "Running, and starts at login" : "Installed, not running"
	}
}
#endif
