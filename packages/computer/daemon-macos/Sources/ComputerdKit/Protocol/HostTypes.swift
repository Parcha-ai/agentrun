import Foundation

// exec.run, files.* and tar.*: the same params and results as protocol.ts. Bytes travel as base64 strings, which
// Foundation's Data coding gives.

public struct ExecRunParams: Sendable, Codable, Equatable {
	public var argv: [String]
	public var cwd: String?
	public var env: [String: String]?
	public var user: String?
	public var timeoutMs: Int
	public var maxOutput: Int?

	public init(argv: [String], cwd: String? = nil, env: [String: String]? = nil, user: String? = nil, timeoutMs: Int, maxOutput: Int? = nil) {
		self.argv = argv
		self.cwd = cwd
		self.env = env
		self.user = user
		self.timeoutMs = timeoutMs
		self.maxOutput = maxOutput
	}
}

public struct ExecRunResult: Sendable, Codable, Equatable {
	/// nil when a signal ended the program; on the wire it is null, never left out.
	public var exitCode: Int?
	public var signal: String?
	public var stdout: Data
	public var stderr: Data
	public var timedOut: Bool
	public var truncated: Bool

	public init(exitCode: Int?, signal: String? = nil, stdout: Data, stderr: Data, timedOut: Bool, truncated: Bool) {
		self.exitCode = exitCode
		self.signal = signal
		self.stdout = stdout
		self.stderr = stderr
		self.timedOut = timedOut
		self.truncated = truncated
	}

	enum CodingKeys: String, CodingKey { case exitCode, signal, stdout, stderr, timedOut, truncated }

	public func encode(to encoder: Encoder) throws {
		var c = encoder.container(keyedBy: CodingKeys.self)
		try c.encode(exitCode, forKey: .exitCode)
		try c.encodeIfPresent(signal, forKey: .signal)
		try c.encode(stdout, forKey: .stdout)
		try c.encode(stderr, forKey: .stderr)
		try c.encode(timedOut, forKey: .timedOut)
		try c.encode(truncated, forKey: .truncated)
	}
}

public struct FilesReadParams: Sendable, Codable, Equatable {
	public var path: String
	public var offset: Int?
	public var length: Int?
}

public struct FilesReadResult: Sendable, Codable, Equatable {
	public var data: Data
	public var eof: Bool
	public var size: Int
}

public struct FilesWriteParams: Sendable, Codable, Equatable {
	public var path: String
	public var data: Data
	public var offset: Int?
	public var append: Bool?
	public var mode: Int?
	public var parents: Bool?
}

public struct FilesWriteResult: Sendable, Codable, Equatable {
	public var size: Int
}

public enum FileType: String, Sendable, Codable {
	case file, dir, symlink, other
}

public struct FileStat: Sendable, Codable, Equatable {
	public var type: FileType
	public var size: Int
	public var mode: Int
	public var mtimeMs: Int
	public var uid: Int
	public var gid: Int
	public var target: String?
}

public struct FilesStatParams: Sendable, Codable, Equatable {
	public var path: String
	public var follow: Bool?
}

public struct FileEntry: Sendable, Codable, Equatable {
	public var path: String
	public var type: FileType
	public var size: Int
	public var mode: Int
	public var mtimeMs: Int
	public var uid: Int
	public var gid: Int
	public var target: String?

	init(path: String, _ stat: FileStat) {
		self.path = path
		type = stat.type
		size = stat.size
		mode = stat.mode
		mtimeMs = stat.mtimeMs
		uid = stat.uid
		gid = stat.gid
		target = stat.target
	}
}

public struct FilesListParams: Sendable, Codable, Equatable {
	public var path: String
	public var depth: Int?
	public var offset: Int?
}

public struct FilesListResult: Sendable, Codable, Equatable {
	public var entries: [FileEntry]
	public var truncated: Bool
}

public struct FilesMkdirParams: Sendable, Codable, Equatable {
	public var path: String
	public var parents: Bool?
	public var mode: Int?
}

public struct FilesMoveParams: Sendable, Codable, Equatable {
	public var from: String
	public var to: String
	public var overwrite: Bool?
}

public struct FilesRemoveParams: Sendable, Codable, Equatable {
	public var path: String
	public var recursive: Bool?
}

public struct TarPathParams: Sendable, Codable, Equatable {
	public var path: String
}

public struct TarIDResult: Sendable, Codable, Equatable {
	public var id: String
}

public struct TarIDParams: Sendable, Codable, Equatable {
	public var id: String
}

public struct TarPullReadParams: Sendable, Codable, Equatable {
	public var id: String
	public var maxBytes: Int?
}

public struct TarPullReadResult: Sendable, Codable, Equatable {
	public var data: Data
	public var eof: Bool
}

public struct TarPushWriteParams: Sendable, Codable, Equatable {
	public var id: String
	public var data: Data
}

public struct TarPushEndResult: Sendable, Codable, Equatable {
	public var entries: Int
}
