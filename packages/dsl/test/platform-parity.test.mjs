// The two platforms of the interpreter (src/platform): the browser one answers what the Node one answers for the
// inputs the interpreter gives it. A change to either file that breaks that fails here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as nodeEqual } from "node:util";
import { test } from "node:test";
import * as browser from "../dist/platform/browser.js";
import * as node from "../dist/platform/node.js";

test("sha256Hex: the browser's pure-JS hash is node:crypto's over strings of every length class and encoding", () => {
  const long = "agentrun ".repeat(30000);
  const strings = ["", "a", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "é", "日本語", "😀", "a\ud800b", "\udc00", "line\nbreak\r\n", JSON.stringify({ a: [1, 2, { b: null }] }), long];
  for (const text of strings) {
    assert.equal(browser.sha256Hex(text), createHash("sha256").update(text).digest("hex"), JSON.stringify(text.slice(0, 20)));
    assert.equal(node.sha256Hex(text), browser.sha256Hex(text));
  }
});

class Point { constructor(x) { this.x = x; } }
class Other { constructor(x) { this.x = x; } }
const sym = Symbol("k");
const pairs = [
  [1, 1], [1, "1"], [NaN, NaN], [0, -0], [0, 0], [null, undefined], [null, null], ["a", "a"], [true, 1],
  [[], []], [[1, 2, 3], [1, 2, 3]], [[1, 2, 3], [1, 3, 2]], [[1, [2, [3]]], [1, [2, [3]]]], [[1, [2, [3]]], [1, [2, [4]]]],
  [{}, {}], [{ a: 1, b: 2 }, { b: 2, a: 1 }], [{ a: 1 }, { a: 1, b: undefined }], [{ a: { b: { c: [1, { d: 2 }] } } }, { a: { b: { c: [1, { d: 2 }] } } }],
  [{ a: undefined }, {}], [{ a: 1 }, { a: 2 }], [[], {}], [{ 0: "a" }, ["a"]],
  [new Point(1), new Point(1)], [new Point(1), new Other(1)], [new Point(1), { x: 1 }],
  [new Date(5), new Date(5)], [new Date(5), new Date(6)],
  // Not here: two invalid Dates. Node's answer changed between its releases (false on 22, true on 24); the browser says true.
  [/a/g, /a/g], [/a/g, /a/i], [/a/, /b/],
  [new Map([[1, 2]]), new Map([[1, 2]])], [new Map([[1, 2]]), new Map([[1, 3]])], [new Map([[{ a: 1 }, 2]]), new Map([[{ a: 1 }, 2]])],
  [new Set([1, 2]), new Set([2, 1])], [new Set([1, 2]), new Set([1, 3])], [new Set([{ a: 1 }]), new Set([{ a: 1 }])],
  [new Uint8Array([1, 2]), new Uint8Array([1, 2])], [new Uint8Array([1, 2]), new Uint8Array([1, 3])], [new Uint8Array([1]), new Int8Array([1])],
  [new Error("x"), new Error("x")], [new Error("x"), new Error("y")], [new TypeError("x"), new Error("x")],
  [{ [sym]: 1 }, { [sym]: 1 }], [{ [sym]: 1 }, { [sym]: 2 }], [{ [sym]: 1 }, {}],
  [Object.assign([1, 2], { extra: 1 }), [1, 2]], [Object.create(null), {}], [Object.create(null), Object.create(null)],
  [new Number(1), new Number(1)], [new Number(1), new Number(2)], [new String("a"), "a"],
  [10n, 10n], [10n, 11n],
];
const cyclic = () => { const a = { n: 1 }; a.self = a; return a; };
pairs.push([cyclic(), cyclic()]);

test("isDeepStrictEqual: the browser's answer is node:util's over equal and unequal pairs", () => {
  for (const [a, b] of pairs) {
    assert.equal(browser.isDeepStrictEqual(a, b), nodeEqual(a, b), `${Object.prototype.toString.call(a)} vs ${Object.prototype.toString.call(b)}`);
    assert.equal(browser.isDeepStrictEqual(b, a), nodeEqual(b, a));
  }
});

const schemas = [
  { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  { type: "object", properties: { a: { type: "array", items: { type: "number" }, minItems: 2 } }, additionalProperties: false },
  { $ref: "#/definitions/X", definitions: { X: { type: "integer", minimum: 3 } } },
  { type: ["string", "null"] }, { enum: [1, 2, 3] }, { anyOf: [{ type: "string" }, { type: "integer" }] },
  { type: "object", properties: { s: { type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 5 } } },
  { type: "object", patternProperties: { "^x-": { type: "string" } }, additionalProperties: false },
  { type: "object", properties: { n: { type: "number", multipleOf: 0.5, exclusiveMaximum: 10 } } },
  { allOf: [{ type: "object", required: ["a"] }, { type: "object", properties: { b: { const: 1 } } }] },
  { type: "array", uniqueItems: true, items: { type: "string" } },
  { oneOf: [{ type: "integer" }, { type: "string", enum: ["x"] }] },
];
const values = [{ a: "x" }, { a: 1 }, {}, 3, "x", "ab", "ABC", null, [1], { a: [1] }, { a: [1, 2], b: 1 }, 2, 0.5, 10, { "x-a": "s" }, { "x-a": 1, y: 1 }, { s: "abc" }, { s: "A" }, { n: 9.5 }, { n: 10 }, ["a", "a"], ["a", "b"], { b: 1, a: 0 }];

test("compileSchema: the browser's validator checks and explains exactly as typebox's compiler does", () => {
  for (const [index, schema] of schemas.entries()) {
    const compiled = node.compileSchema(schema), interpreted = browser.compileSchema(schema);
    for (const value of values) {
      assert.equal(interpreted.Check(value), compiled.Check(value), `schema #${index} value ${JSON.stringify(value)}`);
      assert.deepEqual([...interpreted.Errors(value)], [...compiled.Errors(value)], `schema #${index} errors for ${JSON.stringify(value)}`);
    }
  }
});

test("compileSchema: a schema the compiler refuses is refused by the browser's validator, with the same message", () => {
  for (const bad of [{ type: "string", pattern: "(" }, { type: "object", patternProperties: { "(": {} } }, 42]) {
    let compiled = "", interpreted = "";
    try { node.compileSchema(bad); } catch (error) { compiled = error.message; }
    try { browser.compileSchema(bad); } catch (error) { interpreted = error.message; }
    assert.notEqual(compiled, "", `the compiler refuses ${JSON.stringify(bad)}`);
    assert.equal(interpreted, compiled);
  }
});

test("documentSchema: the browser's generated module is the schema file the Node platform reads", async () => {
  assert.deepEqual(browser.documentSchema, node.documentSchema);
});
