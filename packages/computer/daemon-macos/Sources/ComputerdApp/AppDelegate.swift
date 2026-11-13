#if os(macOS)
import AppKit
import ComputerdKit
import ComputerdMac
import Foundation

/// The app runs in one of two ways. Started by launchd as the LaunchAgent (or with COMPUTERD_SERVE=1), it serves the
/// socket, dials the paired server and keeps a menu bar item. Opened by a person, it installs the LaunchAgent (Agent),
/// shows the grants window while a grant is missing and then the onboarding window, and quits when the last window
/// closes. COMPUTERD_HEADLESS=1 (CI) shows nothing at all.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
	var server: SocketServer?
	var attach: AttachClient?
	var statusItem: NSStatusItem?
	var grants: GrantsWindow?
	var onboarding: Onboarding?
	var attachStatus = "Not paired"
	let environment = ProcessInfo.processInfo.environment
	var headless: Bool { environment["COMPUTERD_HEADLESS"] == "1" }
	/// launchd names a job's processes by its label; an app opened from the Finder gets another name.
	var serving: Bool { environment["XPC_SERVICE_NAME"] == AttachSettings.agentLabel || environment["COMPUTERD_SERVE"] == "1" }

	func applicationDidFinishLaunching(_ notification: Notification) {
		log("Computerd \(driverVersion) starting (\(serving ? "serving" : "settings")); macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
		let missing = Permissions.missing.map(\.rawValue)
		log(missing.isEmpty ? "every grant is in place" : "not granted yet: \(missing.joined(separator: ", "))")
		guard serving else {
			// The grants alone (--until-granted) leave the LaunchAgent as it is: whoever opened the window so set it up.
			if !untilGranted { Agent.install() }
			showOnboarding()
			return
		}
		let controls = Pairing.controls(hello: { MacPlatform.driver().hello() }, changed: { [weak self] in
			Task { @MainActor in self?.startAttach() }
		})
		let server = SocketServer(auth: PeerAuth(), makeDriver: { MacPlatform.driver() }, controls: controls)
		do {
			try server.start()
		} catch {
			log("cannot serve the socket: \(error)")
			exit(1)
		}
		self.server = server
		startAttach()
		if !headless { makeStatusItem() }
	}

	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
		if !headless { showOnboarding() }
		return false
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !serving }

	/// Dials the paired server, if there is one.
	func startAttach() {
		attach?.stop()
		attach = nil
		guard let settings = AttachSettings.load() else {
			setStatus("Not paired")
			return
		}
		let token: String
		do {
			token = try Keychain.token(computer: settings.computer)
		} catch {
			log("attach: \(error)")
			setStatus("Not paired: the token is missing from the keychain")
			return
		}
		let client = AttachClient(settings: settings, token: token, makeDriver: { MacPlatform.driver() }) { [weak self] words in
			Task { @MainActor in self?.setStatus(words) }
		}
		attach = client
		setStatus("Dialing \(settings.server)")
		client.start()
	}

	func setStatus(_ words: String) {
		attachStatus = words
		onboarding?.refresh()
		statusItem?.menu?.item(withTag: 1)?.title = words
	}

	func makeStatusItem() {
		let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		item.button?.title = "⌘D"
		item.button?.toolTip = "Computerd"
		let menu = NSMenu()
		let status = NSMenuItem(title: attachStatus, action: nil, keyEquivalent: "")
		status.tag = 1
		status.isEnabled = false
		menu.addItem(status)
		menu.addItem(.separator())
		menu.addItem(NSMenuItem(title: "Grants and Pairing…", action: #selector(openOnboarding), keyEquivalent: ""))
		menu.addItem(NSMenuItem(title: "Quit Computerd", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
		for entry in menu.items where entry.action == #selector(openOnboarding) { entry.target = self }
		item.menu = menu
		statusItem = item
	}

	@objc func openOnboarding() {
		showOnboarding()
	}

	/// Opened with --until-granted (the Mac mini's bootstrap does), the app's job is the grants alone: the grants window,
	/// which closes once every grant is on, even when they all were when it opened, and nothing after it.
	var untilGranted: Bool { CommandLine.arguments.contains("--until-granted") }

	/// The grants window while a grant is missing (or for the grants alone), else the onboarding window.
	func showOnboarding() {
		if untilGranted || !Permissions.missing.isEmpty { showGrants() } else { showSettings() }
	}

	func showGrants() {
		if grants == nil {
			grants = GrantsWindow(panes: Permissions.panes, onDone: { [weak self] in
				// Before the grants window goes, so the app still has a window and does not quit.
				guard let self, !self.untilGranted else { return }
				self.showSettings()
			}, onClose: { [weak self] in self?.grants = nil })
		}
		grants?.show()
	}

	func showSettings() {
		if onboarding == nil { onboarding = Onboarding(app: self) }
		onboarding?.show()
	}
}

/// The window after the grants: their state with a way back to the grants window, the capture alert, the agent, and
/// pairing. It closes itself once every grant is on and it is paired or pairing is put off, so it never sits over the
/// windows an agent works in.
@MainActor
final class Onboarding: NSObject, NSWindowDelegate {
	weak var app: AppDelegate?
	let window: NSWindow
	let grantsState = NSTextField(labelWithString: "")
	let grantsButton = NSButton(title: "Show…", target: nil, action: nil)
	let alertState = NSTextField(labelWithString: "")
	let alertButton = NSButton(title: "Raise it now", target: nil, action: nil)
	let agentState = NSTextField(labelWithString: "")
	let agentButton = NSButton(title: "Remove", target: nil, action: nil)
	let pairState = NSTextField(labelWithString: "")
	let serverField = NSTextField(string: "")
	let codeField = NSTextField(string: "")
	let pairButton = NSButton(title: "Pair", target: nil, action: nil)
	let laterButton = NSButton(title: "Not now", target: nil, action: nil)
	var timer: Timer?
	/// The person chose to pair later (Not now).
	var pairingPutOff = false
	/// The window closes itself once its job is done. Set when it opens with something left to do, so a window opened
	/// to look at a finished setup stays until it is closed.
	var closeWhenDone = false

	/// Every grant on, and paired or pairing put off: nothing is left for this window.
	var done: Bool { Permissions.missing.isEmpty && (pairingPutOff || AttachSettings.load() != nil) }

	init(app: AppDelegate) {
		self.app = app
		window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
		super.init()
		window.title = "Computerd"
		window.isReleasedWhenClosed = false
		window.delegate = self
		build()
	}

	func label(_ text: String, bold: Bool = false) -> NSTextField {
		let field = NSTextField(wrappingLabelWithString: text)
		if bold { field.font = .boldSystemFont(ofSize: NSFont.systemFontSize) }
		return field
	}

	func build() {
		let stack = NSStackView()
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 10
		stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
		stack.addArrangedSubview(label("Computerd lets an agent use this Mac's apps, as the computer protocol asks.", bold: true))
		grantsButton.target = self
		grantsButton.action = #selector(showGrants)
		let grantsRow = NSStackView(views: [label("Grants: \(Permissions.Grant.allCases.map(\.rawValue).joined(separator: ", ")), which only you can give."), grantsState, grantsButton])
		grantsRow.orientation = .horizontal
		stack.addArrangedSubview(grantsRow)
		alertButton.target = self
		alertButton.action = #selector(raiseAlert)
		let alertRow = NSStackView(views: [label("The screen capture alert: macOS asks once whether Computerd may read the screen directly. Answer it now, not mid-task."), alertState, alertButton])
		alertRow.orientation = .horizontal
		stack.addArrangedSubview(alertRow)
		agentButton.target = self
		agentButton.action = #selector(toggleAgent)
		let agentRow = NSStackView(views: [label("Background agent: runs Computerd at login."), agentState, agentButton])
		agentRow.orientation = .horizontal
		stack.addArrangedSubview(agentRow)
		stack.addArrangedSubview(label("Pair with a server: open its console, ask for a pairing code, and enter both here (or run computerd pair SERVER CODE).", bold: true))
		serverField.placeholderString = "https://agentrun.example"
		codeField.placeholderString = "K7PD-W3QX"
		pairButton.target = self
		pairButton.action = #selector(pair)
		laterButton.target = self
		laterButton.action = #selector(later)
		let pairRow = NSStackView(views: [serverField, codeField, pairButton, laterButton])
		pairRow.orientation = .horizontal
		serverField.widthAnchor.constraint(equalToConstant: 260).isActive = true
		codeField.widthAnchor.constraint(equalToConstant: 110).isActive = true
		stack.addArrangedSubview(pairRow)
		stack.addArrangedSubview(pairState)
		window.contentView = stack
	}

	func show() {
		closeWhenDone = !done
		refresh()
		window.center()
		window.makeKeyAndOrderFront(nil)
		NSApp.activate()
		// Grants change in System Settings, not here: look again each second while the window is open.
		timer?.invalidate()
		timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
			MainActor.assumeIsolated { self?.refresh() }
		}
	}

	func windowWillClose(_ notification: Notification) {
		timer?.invalidate()
		timer = nil
	}

	func refresh() {
		let missing = Permissions.missing.map(\.rawValue)
		grantsState.stringValue = missing.isEmpty ? "All on" : "Missing: \(missing.joined(separator: ", "))"
		let raised = Permissions.captureAlertRaised
		alertState.stringValue = raised ? "Answered" : "Not yet"
		alertButton.isEnabled = !raised && Permissions.Grant.screenRecording.granted
		agentState.stringValue = Agent.state
		agentButton.title = FileManager.default.fileExists(atPath: Agent.plistPath) ? "Remove" : "Install"
		if app?.serving == true {
			pairState.stringValue = app?.attachStatus ?? ""
		} else {
			pairState.stringValue = AttachSettings.load().map { "Paired with \($0.server)" } ?? (pairingPutOff ? "Not paired: pair later from the menu bar item's Grants and Pairing…" : "Not paired")
		}
		laterButton.isEnabled = !pairingPutOff && AttachSettings.load() == nil
		if closeWhenDone && done && window.isVisible {
			// A moment with every row ticked, then the window goes: on a desktop an agent uses, it would cover the
			// windows it works in.
			closeWhenDone = false
			DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.window.close() }
		}
	}

	@objc func later() {
		pairingPutOff = true
		refresh()
	}

	/// Remove boots the agent out and deletes its plist; Install puts it back.
	@objc func toggleAgent() {
		if FileManager.default.fileExists(atPath: Agent.plistPath) {
			Agent.remove()
		} else if let why = Agent.install() {
			agentState.stringValue = "Not installed: \(why)"
			return
		}
		refresh()
	}

	@objc func showGrants() {
		app?.showGrants()
	}

	@objc func raiseAlert() {
		Task {
			let why = await Permissions.raiseCaptureAlert()
			await MainActor.run {
				if let why { self.alertState.stringValue = "Not raised: \(why)" } else { self.refresh() }
			}
		}
	}

	@objc func pair() {
		let server = serverField.stringValue.trimmingCharacters(in: .whitespaces)
		let code = codeField.stringValue
		pairButton.isEnabled = false
		pairState.stringValue = "Pairing…"
		// The agent pairs, as for the command line: it owns the keychain, and dials once paired.
		Task.detached {
			do {
				let reply = try LocalCall.call(Control.pair, try Coders.json(PairParams(server: server, code: code)))
				let settings = try Coders.decoder().decode(AttachSettings.self, from: try Coders.encode(reply))
				await MainActor.run {
					self.pairState.stringValue = "Paired with \(settings.server)"
					self.pairButton.isEnabled = true
					self.refresh()
				}
			} catch {
				let words = (error as? RPCError)?.message ?? error.localizedDescription
				await MainActor.run {
					self.pairState.stringValue = "Not paired: \(words)"
					self.pairButton.isEnabled = true
				}
			}
		}
	}
}
#endif
