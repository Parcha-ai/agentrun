import Foundation

/// A JSON value, as the wire carries it. Numbers keep whether they were whole, so an id echoes back as it came.
public enum JSON: Sendable, Equatable, Codable {
	case null
	case bool(Bool)
	case int(Int64)
	case double(Double)
	case string(String)
	case array([JSON])
	case object([String: JSON])

	public init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if c.decodeNil() {
			self = .null
		} else if let b = try? c.decode(Bool.self) {
			self = .bool(b)
		} else if let i = try? c.decode(Int64.self) {
			self = .int(i)
		} else if let d = try? c.decode(Double.self) {
			self = .double(d)
		} else if let s = try? c.decode(String.self) {
			self = .string(s)
		} else if let a = try? c.decode([JSON].self) {
			self = .array(a)
		} else {
			self = .object(try c.decode([String: JSON].self))
		}
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.singleValueContainer()
		switch self {
		case .null: try c.encodeNil()
		case .bool(let b): try c.encode(b)
		case .int(let i): try c.encode(i)
		case .double(let d): try c.encode(d)
		case .string(let s): try c.encode(s)
		case .array(let a): try c.encode(a)
		case .object(let o): try c.encode(o)
		}
	}

	public subscript(key: String) -> JSON? {
		if case .object(let o) = self { return o[key] }
		return nil
	}

	public var objectValue: [String: JSON]? {
		if case .object(let o) = self { return o }
		return nil
	}

	public var stringValue: String? {
		if case .string(let s) = self { return s }
		return nil
	}
}

/// The coders every part of the driver uses: keys as written, no escaped slashes, sorted keys for stable output.
public enum Coders {
	public static func encoder() -> JSONEncoder {
		let e = JSONEncoder()
		e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
		return e
	}

	public static func decoder() -> JSONDecoder { JSONDecoder() }

	public static func encode<T: Encodable>(_ value: T) throws -> Data { try encoder().encode(value) }

	/// Encodes a value and reads it back as JSON, the shape a reply carries.
	public static func json<T: Encodable>(_ value: T) throws -> JSON {
		try decoder().decode(JSON.self, from: encode(value))
	}
}
