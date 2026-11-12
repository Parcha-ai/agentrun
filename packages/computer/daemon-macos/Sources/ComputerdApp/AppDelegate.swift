#if os(macOS)
import AppKit
import ComputerdKit
import ComputerdMac
import Foundation

/// The app runs in one of two ways. Started by launchd as the LaunchAgent (or with COMPUTERD_SERVE=1), it serves the
/// socket, dials the paired server and keeps a menu bar item. Opened by a person, it registers the LaunchAgent and
/// shows the onboarding window, and quits when the window closes. COMPUTERD_HEADLESS=1 (CI) shows nothing at all.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
	var server: SocketServer?
	var attach: AttachClient?
	var statusItem: NSStatusItem?
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
			Agent.register()
			showOnboarding()
			return
		}
		let server = SocketServer(auth: PeerAuth(), makeDriver: { MacPlatform.driver() })
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

	/// After pairing: the serving app dials again, and the settings copy restarts the agent so it does.
	func paired() {
		if serving { startAttach() } else { restartAgent() }
	}

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

	func showOnboarding() {
		if onboarding == nil { onboarding = Onboarding(app: self) }
		onboarding?.show()
	}
}

/// One window: each grant with its state and a button that asks for it, the capture alert, and pairing.
final class Onboarding: NSObject, NSWindowDelegate {
	weak var app: AppDelegate?
	let window: NSWindow
	var rows: [(grant: Permissions.Grant, state: NSTextField, button: NSButton)] = []
	let alertState = NSTextField(labelWithString: "")
	let alertButton = NSButton(title: "Raise it now", target: nil, action: nil)
	let agentState = NSTextField(labelWithString: "")
	let pairState = NSTextField(labelWithString: "")
	let serverField = NSTextField(string: "")
	let codeField = NSTextField(string: "")
	let pairButton = NSButton(title: "Pair", target: nil, action: nil)
	var timer: Timer?

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
		stack.addArrangedSubview(label("Computerd lets an agent use this Mac's apps, as the computer protocol asks. It needs three grants, which only you can give.", bold: true))
		for grant in Permissions.Grant.allCases {
			let state = NSTextField(labelWithString: "")
			let button = NSButton(title: "Allow…", target: self, action: #selector(ask(_:)))
			button.tag = rows.count
			let row = NSStackView(views: [label("\(grant.rawValue): to \(grant.purpose)."), state, button])
			row.orientation = .horizontal
			stack.addArrangedSubview(row)
			rows.append((grant, state, button))
		}
		alertButton.target = self
		alertButton.action = #selector(raiseAlert)
		let alertRow = NSStackView(views: [label("The screen capture alert: macOS asks once whether Computerd may read the screen directly. Answer it now, not mid-task."), alertState, alertButton])
		alertRow.orientation = .horizontal
		stack.addArrangedSubview(alertRow)
		let agentButton = NSButton(title: "Login Items…", target: self, action: #selector(loginItems))
		let agentRow = NSStackView(views: [label("Background agent: runs Computerd at login."), agentState, agentButton])
		agentRow.orientation = .horizontal
		stack.addArrangedSubview(agentRow)
		stack.addArrangedSubview(label("Pair with a server: open its console, ask for a pairing code, and enter both here (or run computerd pair SERVER CODE).", bold: true))
		serverField.placeholderString = "https://agentrun.example"
		codeField.placeholderString = "K7PD-W3QX"
		pairButton.target = self
		pairButton.action = #selector(pair)
		let pairRow = NSStackView(views: [serverField, codeField, pairButton])
		pairRow.orientation = .horizontal
		serverField.widthAnchor.constraint(equalToConstant: 260).isActive = true
		codeField.widthAnchor.constraint(equalToConstant: 110).isActive = true
		stack.addArrangedSubview(pairRow)
		stack.addArrangedSubview(pairState)
		window.contentView = stack
	}

	func show() {
		refresh()
		window.center()
		window.makeKeyAndOrderFront(nil)
		NSApp.activate()
		// Grants change in System Settings, not here: look again each second while the window is open.
		timer?.invalidate()
		timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
	}

	func windowWillClose(_ notification: Notification) {
		timer?.invalidate()
		timer = nil
	}

	func refresh() {
		for row in rows {
			let granted = row.grant.granted
			row.state.stringValue = granted ? "Granted" : "Not granted"
			row.button.isEnabled = !granted
		}
		let raised = Permissions.captureAlertRaised
		alertState.stringValue = raised ? "Answered" : "Not yet"
		alertButton.isEnabled = !raised && Permissions.Grant.screenRecording.granted
		agentState.stringValue = Agent.state
		if app?.serving == true {
			pairState.stringValue = app?.attachStatus ?? ""
		} else {
			pairState.stringValue = AttachSettings.load().map { "Paired with \($0.server)" } ?? "Not paired"
		}
	}

	@objc func loginItems() {
		Agent.openLoginItems()
	}

	@objc func ask(_ sender: NSButton) {
		let grant = rows[sender.tag].grant
		grant.request()
		NSWorkspace.shared.open(grant.settings)
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
		Task {
			do {
				let settings = try await Pairing.pair(server: server, code: code, name: nil)
				await MainActor.run {
					self.pairState.stringValue = "Paired with \(settings.server)"
					self.pairButton.isEnabled = true
					self.app?.paired()
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
