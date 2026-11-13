import Foundation

/// Reads a method's params into its type, strictly: each params object is closed, as the schema says
/// (additionalProperties: false), so an unknown field or a value of the wrong type is an error of kind invalid.
///
/// The check is generic: the params are decoded, encoded again, and every key the caller sent must come back. A field
/// the type does not know is dropped by decoding, so it is missing from the encoding and named in the refusal. Every
/// wire type encodes what it decoded, which the tests hold for each one.
public enum Params {
	public static func decode<P: Decodable & Encodable>(_ type: P.Type, _ params: JSON?, method: String) throws -> P {
		let given = params ?? .object([:])
		guard case .object = given else {
			throw RPCError.invalid("\(method)'s params must be an object")
		}
		let value: P
		do {
			value = try Coders.decoder().decode(P.self, from: Coders.encode(given))
		} catch let error as RPCError {
			throw error
		} catch let error as DecodingError {
			throw RPCError.invalid("\(method): \(words(error))")
		}
		let back = try Coders.json(value)
		if let extra = firstUnknown(given, back, path: "params") {
			throw RPCError.invalid("\(method): \(extra)")
		}
		return value
	}

	/// The first key in given that back does not have, as words; nil when there is none.
	static func firstUnknown(_ given: JSON, _ back: JSON, path: String) -> String? {
		switch (given, back) {
		case (.object(let g), .object(let b)):
			for key in g.keys.sorted() {
				let value = g[key]!
				guard let other = b[key] else {
					if value == .null { return "\(path).\(key) is null; leave it out instead" }
					return "\(path).\(key) is not a field it takes"
				}
				if let found = firstUnknown(value, other, path: "\(path).\(key)") { return found }
			}
			return nil
		case (.array(let g), .array(let b)) where g.count == b.count:
			for (i, (x, y)) in zip(g, b).enumerated() {
				if let found = firstUnknown(x, y, path: "\(path)[\(i)]") { return found }
			}
			return nil
		default:
			return nil
		}
	}

	/// A decoding error in words a person can act on, with the field's path.
	static func words(_ error: DecodingError) -> String {
		func at(_ path: [CodingKey]) -> String {
			var out = "params"
			for key in path {
				if let i = key.intValue { out += "[\(i)]" } else { out += ".\(key.stringValue)" }
			}
			return out
		}
		switch error {
		case .keyNotFound(let key, let ctx):
			return "\(at(ctx.codingPath + [key])) is required"
		case .typeMismatch(let type, let ctx):
			return "\(at(ctx.codingPath)) must be \(name(of: type))"
		case .valueNotFound(let type, let ctx):
			return "\(at(ctx.codingPath)) must be \(name(of: type)), not null"
		case .dataCorrupted(let ctx):
			return "\(at(ctx.codingPath)): \(ctx.debugDescription)"
		@unknown default:
			return "the params do not match the method's schema"
		}
	}

	static func name(of type: Any.Type) -> String {
		switch type {
		case is String.Type: return "a string"
		case is Bool.Type: return "true or false"
		case is Int.Type, is Int64.Type, is UInt32.Type: return "a whole number"
		case is Double.Type: return "a number"
		default:
			let n = String(describing: type)
			if n.hasPrefix("Array") { return "an array" }
			if n.hasPrefix("Dictionary") { return "an object" }
			return "a \(n)"
		}
	}
}

extension Decoder {
	/// Throws a dataCorrupted error at this decoder's path, with words.
	public func corrupted(_ words: String) -> DecodingError {
		DecodingError.dataCorrupted(DecodingError.Context(codingPath: codingPath, debugDescription: words))
	}
}
