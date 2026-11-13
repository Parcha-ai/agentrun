import Foundation

/// What a driver says about the machine in hello, apart from its features.
public struct MachineInfo: Sendable {
	public var os: String
	public var osVersion: String?
	public var kind: String
	public var arch: String
	public var device: Device?

	public init(os: String = "macos", osVersion: String?, kind: String = "desktop", arch: String = goArch, device: Device?) {
		self.os = os
		self.osVersion = osVersion
		self.kind = kind
		self.arch = arch
		self.device = device
	}
}

/// One connection's methods: hello and ping, exec, files and tar, screen, input, apps, and the ui group, over one
/// Platform and one claim's Policy. A driver makes one per connection, so states, refs, images and tar streams are the
/// connection's.
public final class Driver: Sendable {
	/// In protocol.json's order. screen, input.pointer and input.keys make it a desktop (kinds.md).
	public static let groups: [Group] = [.exec, .files, .screen, .inputPointer, .inputKeys, .apps, .ui]

	let platform: Platform
	let policy: Policy
	let machine: MachineInfo
	let shots = ShotStore()
	let tar = TarSessions()
	let watch = Watch()
	public let ui: UIEngine

	public init(platform: Platform, policy: Policy, machine: MachineInfo, timing: Timing = Timing()) {
		self.platform = platform
		self.policy = policy
		self.machine = machine
		ui = UIEngine(platform: platform, policy: policy, timing: timing)
	}

	/// hello: what the computer is, and each feature on or off with the reason.
	public func hello() -> HelloResult {
		HelloResult(os: machine.os, osVersion: machine.osVersion, kind: machine.kind, arch: machine.arch, groups: Self.groups, screen: platform.capture.screenInfo(), features: features(), device: machine.device)
	}

	/// Each feature on, or off with why. Without the tree (Accessibility) the window's image still comes and steps at
	/// its points still run; without the tree and the image, ui.observe is refused.
	public func features() -> [String: Feature] {
		[
			FeatureName.appsBackground: platform.workspace.backgroundLaunch,
			FeatureName.tree: platform.accessibility.feature,
			FeatureName.image: platform.capture.feature,
			FeatureName.background: platform.backgroundFeature,
			FeatureName.foreground: platform.foregroundFeature,
			FeatureName.page: .off("web pages through the browser's own protocol are not built yet: pages are read through the accessibility tree"),
			FeatureName.nav: platform.navFeature,
		]
	}

	public func router() -> Router {
		var r = Router()
		r.onAny("hello") { self.hello() }
		r.onAny("ping") { Empty() }

		r.on("exec.run", ExecRunParams.self) { try await Exec.run($0) }

		r.on("files.read", FilesReadParams.self) { try Files.readFile($0) }
		r.on("files.write", FilesWriteParams.self) { try Files.writeFile($0) }
		r.on("files.stat", FilesStatParams.self) { try Files.statPath($0) }
		r.on("files.list", FilesListParams.self) { try Files.listDir($0) }
		r.on("files.mkdir", FilesMkdirParams.self) { try Files.makeDir($0); return Empty() }
		r.on("files.move", FilesMoveParams.self) { try Files.movePath($0); return Empty() }
		r.on("files.remove", FilesRemoveParams.self) { try Files.removePath($0); return Empty() }
		r.on("tar.pull.begin", TarPathParams.self) { try await self.tar.pullBegin($0) }
		r.on("tar.pull.read", TarPullReadParams.self) { try await self.tar.pullRead($0) }
		r.on("tar.pull.end", TarIDParams.self) { await self.tar.pullEnd($0); return Empty() }
		r.on("tar.push.begin", TarPathParams.self) { try await self.tar.pushBegin($0) }
		r.on("tar.push.write", TarPushWriteParams.self) { try await self.tar.pushWrite($0); return Empty() }
		r.on("tar.push.end", TarIDParams.self) { try await self.tar.pushEnd($0) }

		r.on("screen.shot", ScreenShotParams.self) { try await self.shot($0) }
		r.on("screen.read", ScreenReadParams.self) { try await self.shots.read($0.id, offset: $0.offset) }
		r.on("screen.watch", ScreenWatchParams.self) { try await self.watch.next($0, capture: self.platform.capture, shots: self.shots, clock: self.platform.clock) }

		r.on("input.actions", InputActionsParams.self) { p in
			try await InputBatch(platform: self.platform, policy: self.policy, groups: Self.groups).run(p.actions)
		}

		r.on("apps.list", Empty.self) { _ in self.apps() }
		r.on("apps.launch", AppsLaunchParams.self) { p in
			try self.policy.check(p.id)
			let background = p.background ?? false
			if background, case .off(let reason) = self.platform.workspace.backgroundLaunch {
				throw RPCError.unsupported("apps.launch: apps.background is off here: \(reason)")
			}
			try await self.platform.workspace.launch(p.id, url: p.url, background: background)
			return Empty()
		}
		r.on("apps.terminate", AppsTerminateParams.self) { p in
			try self.policy.check(p.id)
			try self.platform.workspace.terminate(p.id)
			return Empty()
		}

		r.on("ui.observe", UiObserveParams.self) { try await self.ui.observe($0) }
		r.on("ui.act", UiActParams.self) { try await self.ui.act($0) }
		return r
	}

	/// The apps a claim may see: only its own when it names them.
	func apps() -> AppsListResult {
		var list = platform.workspace.list()
		if policy.apps != nil {
			list.apps = list.apps.filter { policy.allows($0.id) }
			if let front = list.foreground, !policy.allows(front) { list.foreground = nil }
		}
		return list
	}

	func shot(_ p: ScreenShotParams) async throws -> ScreenShotResult {
		if case .off(let reason) = platform.capture.feature { throw RPCError.denied(reason) }
		if let r = p.region, r.w <= 0 || r.h <= 0 { throw RPCError.invalid("a region has a positive width and height") }
		let image = try await platform.capture.screen(region: p.region)
		let held = await shots.hold(image.data)
		let full = platform.capture.screenInfo()
		let width = full.map { Int(($0.width * $0.scale).rounded()) } ?? image.width
		let height = full.map { Int(($0.height * $0.scale).rounded()) } ?? image.height
		return ScreenShotResult(id: held.id, size: image.data.count, data: held.first, eof: held.eof, width: width, height: height, scale: image.scale, cursor: platform.capture.cursor())
	}

	/// Ends what the connection left open: its tar streams.
	public func close() async {
		await tar.closeAll()
	}
}

/// screen.watch: the next frame of the live view once the screen changed since the caller's last.
actor Watch {
	var seq = 0
	var lastHash: Int?
	var last: (data: Data, width: Int, height: Int)?

	func next(_ p: ScreenWatchParams, capture: any Capture, shots: ShotStore, clock: any Clock) async throws -> ScreenWatchResult {
		if case .off(let reason) = capture.feature { throw RPCError.denied(reason) }
		let wait = Double(p.waitMs ?? 2000)
		guard (0...10_000).contains(wait) else { throw RPCError.invalid("waitMs is from 0 to 10000") }
		let maxWidth = p.maxWidth ?? 1280
		let quality = p.quality ?? 60
		guard maxWidth >= 16 else { throw RPCError.invalid("maxWidth must be 16 or more") }
		guard (1...100).contains(quality) else { throw RPCError.invalid("quality is from 1 to 100") }
		let screen = capture.screenInfo()
		let width = screen.map { Int(($0.width * $0.scale).rounded()) } ?? 0
		let height = screen.map { Int(($0.height * $0.scale).rounded()) } ?? 0
		let until = clock.now() + wait
		while true {
			// An ack older than the newest frame gets the newest at once.
			if p.after < seq, let last {
				return try await frame(last, width: width, height: height, shots: shots, capture: capture)
			}
			let image = try await capture.frame(maxWidth: maxWidth, quality: quality)
			let hash = image.data.hashValue
			if hash != lastHash {
				lastHash = hash
				seq += 1
				last = (image.data, image.width, image.height)
				return try await frame(last!, width: width, height: height, shots: shots, capture: capture)
			}
			if clock.now() >= until { return ScreenWatchResult(seq: seq, changed: false, width: width, height: height, cursor: capture.cursor()) }
			do {
				try await clock.sleep(ms: 100)
			} catch {
				throw RPCError.aborted
			}
		}
	}

	func frame(_ f: (data: Data, width: Int, height: Int), width: Int, height: Int, shots: ShotStore, capture: any Capture) async throws -> ScreenWatchResult {
		let held = await shots.hold(f.data)
		return ScreenWatchResult(seq: seq, changed: true, id: held.id, size: f.data.count, data: held.first, eof: held.eof, format: "jpeg", frameWidth: f.width, frameHeight: f.height, width: width, height: height, cursor: capture.cursor())
	}
}
