import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// files.*: read, write, list and move files as the logged-in user, with the same rules and error kinds as the Go
/// daemon (packages/computer/daemon/internal/files). Every path is absolute; it is cleaned before use.
public enum Files {
	/// A path from a request: absolute, with no NUL, cleaned.
	static func clean(_ field: String, _ path: String) throws -> String {
		guard path.hasPrefix("/") else { throw RPCError.invalid("\(field) must be an absolute path, not \(path.debugDescription)") }
		guard !path.contains("\0") else { throw RPCError.invalid("\(field) has a NUL byte") }
		var parts: [Substring] = []
		for part in path.split(separator: "/") {
			if part == "." { continue }
			if part == ".." {
				_ = parts.popLast()
				continue
			}
			parts.append(part)
		}
		return "/" + parts.joined(separator: "/")
	}

	/// An errno as the protocol's kind, with the call and the path in the words.
	static func error(_ code: Int32, _ op: String, _ path: String) -> RPCError {
		let words = "\(op) \(path): \(String(cString: strerror(code)))"
		switch code {
		case ENOENT: return RPCError(.notFound, words)
		case EACCES, EPERM, EROFS: return RPCError(.denied, words)
		case EEXIST: return RPCError(.exists, words)
		case ENOTDIR: return RPCError(.notDir, words)
		case EISDIR: return RPCError(.isDir, words)
		case EXDEV: return RPCError(.unsupported, words)
		case ENOSPC, EDQUOT, EFBIG: return RPCError(.limit, words)
		default: return RPCError(.invalid, words)
		}
	}

	static func mode(_ given: Int?, otherwise: mode_t) throws -> mode_t {
		guard let given else { return otherwise }
		guard given >= 0, given <= 0o7777 else {
			throw RPCError.invalid("mode \(String(given, radix: 8)) has bits beyond 07777")
		}
		return mode_t(given)
	}

	/// Opens a regular file: a FIFO or a device never blocks the open, a directory is is_dir, anything else invalid.
	static func openRegular(_ path: String, _ flags: Int32, _ perm: mode_t) throws -> Int32 {
		let fd = open(path, flags | O_NONBLOCK | O_CLOEXEC, perm)
		if fd < 0 {
			let code = errno
			if code == ENXIO { throw RPCError.invalid("\(path) is not a regular file") }
			throw error(code, "open", path)
		}
		var st = stat()
		guard fstat(fd, &st) == 0 else {
			let code = errno
			close(fd)
			throw error(code, "stat", path)
		}
		switch st.st_mode & S_IFMT {
		case S_IFREG:
			let current = fcntl(fd, F_GETFL)
			_ = fcntl(fd, F_SETFL, current & ~O_NONBLOCK)
			return fd
		case S_IFDIR:
			close(fd)
			throw RPCError(.isDir, "\(path) is a directory")
		default:
			close(fd)
			throw RPCError.invalid("\(path) is not a regular file")
		}
	}

	public static func readFile(_ p: FilesReadParams) throws -> FilesReadResult {
		let path = try clean("path", p.path)
		let offset = p.offset ?? 0
		let length = p.length ?? Limits.maxChunkBytes
		guard offset >= 0 else { throw RPCError.invalid("offset must be 0 or more") }
		guard length >= 1 else { throw RPCError.invalid("length must be 1 or more") }
		guard length <= Limits.maxChunkBytes else {
			throw RPCError.limit("a files.read returns at most \(Limits.maxChunkBytes) bytes: read again from offset + the bytes read")
		}
		let fd = try openRegular(path, O_RDONLY, 0)
		defer { close(fd) }
		var buffer = [UInt8](repeating: 0, count: length)
		var got = 0
		while got < length {
			let n = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress! + got, length - got, off_t(offset + got)) }
			if n < 0 {
				if errno == EINTR { continue }
				throw error(errno, "read", path)
			}
			if n == 0 { break }
			got += n
		}
		var st = stat()
		guard fstat(fd, &st) == 0 else { throw error(errno, "stat", path) }
		let size = Int(st.st_size)
		return FilesReadResult(data: Data(buffer[0..<got]), eof: got < length || offset + got >= size, size: size)
	}

	public static func writeFile(_ p: FilesWriteParams) throws -> FilesWriteResult {
		let path = try clean("path", p.path)
		let append = p.append ?? false
		if p.offset != nil && append { throw RPCError.invalid("offset and append cannot both be given") }
		if let offset = p.offset, offset < 0 { throw RPCError.invalid("offset must be 0 or more") }
		let perm = try mode(p.mode, otherwise: 0o644)
		if p.parents ?? false { try makeParents(of: path) }
		var flags = O_WRONLY
		if append {
			flags |= O_APPEND
		} else if p.offset == nil {
			flags |= O_TRUNC
		}
		var created = true
		var fd: Int32
		do {
			fd = try openRegular(path, flags | O_CREAT | O_EXCL, perm & 0o777)
		} catch let e as RPCError where e.kind == .exists {
			created = false
			fd = try openRegular(path, flags, 0)
		}
		defer { close(fd) }
		if created || p.mode != nil {
			guard fchmod(fd, perm) == 0 else { throw error(errno, "chmod", path) }
		}
		let ok = p.data.withUnsafeBytes { raw -> Bool in
			var done = 0
			while done < raw.count {
				let n = p.offset.map { pwrite(fd, raw.baseAddress! + done, raw.count - done, off_t($0 + done)) } ?? sysWrite(fd, raw.baseAddress! + done, raw.count - done)
				if n < 0 {
					if errno == EINTR { continue }
					return false
				}
				done += n
			}
			return true
		}
		guard ok else { throw error(errno, "write", path) }
		var st = stat()
		guard fstat(fd, &st) == 0 else { throw error(errno, "stat", path) }
		return FilesWriteResult(size: Int(st.st_size))
	}

	static func makeParents(of path: String) throws {
		let parent = (path as NSString).deletingLastPathComponent
		do {
			try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
		} catch {
			var st = stat()
			if stat(parent, &st) == 0 && st.st_mode & S_IFMT != S_IFDIR { throw RPCError(.notDir, "\(parent) is not a directory") }
			throw RPCError(.denied, "cannot make \(parent): \(error.localizedDescription)")
		}
	}

	static func describe(_ path: String, follow: Bool) throws -> FileStat {
		var st = stat()
		let rc = follow ? stat(path, &st) : lstat(path, &st)
		guard rc == 0 else { throw error(errno, follow ? "stat" : "lstat", path) }
		let type: FileType
		switch st.st_mode & S_IFMT {
		case S_IFREG: type = .file
		case S_IFDIR: type = .dir
		case S_IFLNK: type = .symlink
		default: type = .other
		}
		var target: String?
		if type == .symlink {
			target = try? FileManager.default.destinationOfSymbolicLink(atPath: path)
		}
		#if canImport(Darwin)
		let mtime = st.st_mtimespec
		#else
		let mtime = st.st_mtim
		#endif
		let ms = Int(mtime.tv_sec) * 1000 + Int(mtime.tv_nsec) / 1_000_000
		return FileStat(type: type, size: Int(st.st_size), mode: Int(st.st_mode & 0o7777), mtimeMs: ms, uid: Int(st.st_uid), gid: Int(st.st_gid), target: target)
	}

	public static func statPath(_ p: FilesStatParams) throws -> FileStat {
		try describe(try clean("path", p.path), follow: p.follow ?? false)
	}

	static let maxListBytes = 768 * 1024

	public static func listDir(_ p: FilesListParams) throws -> FilesListResult {
		let path = try clean("path", p.path)
		let depth = p.depth ?? 1
		let offset = p.offset ?? 0
		guard (1...Limits.maxListDepth).contains(depth) else { throw RPCError.invalid("depth must be from 1 to \(Limits.maxListDepth)") }
		guard offset >= 0 else { throw RPCError.invalid("offset must be 0 or more") }
		let resolved = (path as NSString).resolvingSymlinksInPath
		let top = try describe(resolved, follow: true)
		guard top.type == .dir else { throw RPCError(.notDir, "\(path) is not a directory") }
		var entries: [FileEntry] = []
		var skipped = 0
		var budget = maxListBytes
		var truncated = false
		let encoder = Coders.encoder()
		// Walk order: each directory's entries by name, a directory before what it holds.
		func walk(_ dir: String, _ shown: String, _ level: Int) -> Bool {
			guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return true }
			for name in names.sorted() {
				let full = dir + "/" + name
				guard let stat = try? describe(full, follow: false) else { continue }
				if skipped < offset {
					skipped += 1
				} else {
					let entry = FileEntry(path: shown + "/" + name, stat)
					let size = ((try? encoder.encode(entry))?.count ?? 0) + 1
					if entries.count == Limits.maxListEntries || size > budget {
						truncated = true
						return false
					}
					budget -= size
					entries.append(entry)
				}
				if stat.type == .dir && level < depth {
					if !walk(full, shown + "/" + name, level + 1) { return false }
				}
			}
			return true
		}
		_ = walk(resolved == "/" ? "" : resolved, path == "/" ? "" : path, 1)
		return FilesListResult(entries: entries, truncated: truncated)
	}

	public static func makeDir(_ p: FilesMkdirParams) throws {
		let path = try clean("path", p.path)
		let perm = try mode(p.mode, otherwise: 0o755)
		let parents = p.parents ?? false
		if parents { try makeParents(of: path) }
		if sysMkdir(path, perm) != 0 {
			let code = errno
			if code == EEXIST, parents, (try? describe(path, follow: true))?.type == .dir { return }
			throw error(code, "mkdir", path)
		}
		guard chmod(path, perm) == 0 else { throw error(errno, "chmod", path) }
	}

	public static func movePath(_ p: FilesMoveParams) throws {
		let from = try clean("from", p.from)
		let to = try clean("to", p.to)
		guard from != to else { throw RPCError.invalid("from and to are the same path") }
		let source = try describe(from, follow: false)
		if source.type == .dir && to.hasPrefix(from + "/") {
			throw RPCError.invalid("cannot move \(from) into itself")
		}
		if p.overwrite ?? false {
			guard rename(from, to) == 0 else { throw moveError(errno, from, to) }
			return
		}
		#if canImport(Darwin)
		guard renamex_np(from, to, UInt32(RENAME_EXCL)) == 0 else { throw moveError(errno, from, to) }
		#else
		// Linux runs only the core's tests: a check, then the rename.
		var st = stat()
		if sysLstat(to, &st) == 0 { throw moveError(EEXIST, from, to) }
		guard rename(from, to) == 0 else { throw moveError(errno, from, to) }
		#endif
	}

	static func moveError(_ code: Int32, _ from: String, _ to: String) -> RPCError {
		switch code {
		case EEXIST, ENOTEMPTY: return RPCError(.exists, "\(to) exists: pass overwrite to replace it")
		case EXDEV: return RPCError(.unsupported, "cannot move \(from) to \(to) across filesystems: copy it, then remove it")
		default: return error(code, "rename", from)
		}
	}

	public static func removePath(_ p: FilesRemoveParams) throws {
		let path = try clean("path", p.path)
		guard path != "/" else { throw RPCError.denied("the filesystem root is never removed") }
		let info = try describe(path, follow: false)
		if info.type == .dir {
			if p.recursive ?? false {
				do {
					try FileManager.default.removeItem(atPath: path)
				} catch {
					throw RPCError(.denied, "cannot remove \(path): \(error.localizedDescription)")
				}
				return
			}
			guard rmdir(path) == 0 else {
				let code = errno
				if code == ENOTEMPTY || code == EEXIST {
					throw RPCError(.isDir, "\(path) is a directory with entries: pass recursive to remove it all")
				}
				throw error(code, "rmdir", path)
			}
			return
		}
		guard unlink(path) == 0 else { throw error(errno, "unlink", path) }
	}
}
