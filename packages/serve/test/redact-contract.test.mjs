// The contract every redactor of served text keeps, one table run through each entry point there is: a row's head
// (redacted), an answer (redactedAnswer), a call's result as a grader reads it (redactedCall, cut to CALL_RESULT_CHARS),
// learning's printer (redactSecrets at PRINT_MAX) and a file read with cut=run (redactSecrets over the whole text, as
// run-reads-over-store.ts cutRunFile calls it). Each case names what no entry point may show, and the exact text where
// an entry point's own contract fixes it. Where the entry points answer differently, the test's diagnostics say which
// differ, so a change that moves one of them shows up there. Every key-shaped text here is put together at run time.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { addressForms } from "../dist/calendar/address.js";
import * as refusal from "../dist/key-refusal.js";
import { redactLearned, redactSecrets } from "../dist/learn/secrets.js";
import { CALL_RESULT_CHARS, scrubUrls } from "../dist/timeline/index.js";
import { cut } from "../dist/timeline/util.js";

const ENTRIES = {
  redacted: (text, values) => refusal.redacted(text, values),
  redactedAnswer: (text, values) => refusal.redactedAnswer(text, values),
  redactedCall: (text, values) => cut(refusal.redactedCall(text, values, CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS),
  redactSecrets: (text, values) => redactSecrets(text, values),
  runFile: (text, values) => redactSecrets(text, values, Buffer.byteLength(text)),
};

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
/** A held value of 64 characters in no secret's shape. */
const SPLIT = `${["not-a-secret", "split-key"].join("-")}-${"0123456789abcdef".repeat(3)}`.slice(0, 64);
const P24 = ["Zq8VbN3xLmT6pR2w", "Yk9HsD4fGj7Ac5Ue"];
const login = (user, password) => [user, password].join(":");
const SIZE = 256 * 1024;
const fill = (unit, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** Characters that render as nothing, by code point: a zero-width space, a soft hyphen, a byte order mark. */
const [ZWSP, SHY, BOM] = [0x200b, 0xad, 0xfeff].map((code) => String.fromCharCode(code));
/** A made-up PEM-like key: `count` body lines of 64 characters (turns of the base64 of "fake-body-not-a-real-key", each
 *  numbered), its armor built in pieces. */
const fakePem = (count) => {
  const body = "ZmFrZS1ib2R5LW5vdC1hLXJlYWwta2V5".repeat(3);
  const lines = Array.from({ length: count }, (_, i) => `${String(i).padStart(4, "0")}${body.slice(i % 32, (i % 32) + 60)}`);
  return { lines, pem: [`-----BEGIN ${"PRIVATE KEY"}-----`, ...lines, `-----END ${"PRIVATE KEY"}-----`].join("\n") };
};

/** Each case: the text, the held values, what no entry point shows (`hides`), and where an entry point's contract fixes
 *  its answer, that answer (`exact`). `entries` narrows a case to the entry points whose contract it is. */
const CASES = [
  {
    name: "P2-4: a held value whose first half is a credential parameter's value and whose second half is past a line break",
    text: `cb?token=${P24[0]}\n${P24[1]} ok`,
    values: [P24.join("")],
    hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
  },
  // P2-4's controls: the held value whole after the parameter, and its head alone there, are cut in place.
  ...[[P24.join(""), "whole"], [`${P24[0]}x`, "its head and one more character"]].map(([value, what]) => ({
    name: `a credential parameter's value that is ${what} of a held value is cut in place`,
    text: `cb?token=${value} ok`,
    values: [P24.join("")],
    hides: [P24[0].slice(0, 8)],
    exact: { redacted: "cb?token=[redacted] ok", redactedAnswer: "cb?token=[redacted] ok", redactSecrets: "cb?token=[redacted] ok", runFile: "cb?token=[redacted] ok" },
  })),
  // A held value only a view finds, wholly inside a cut in place, is cut with it: an address held as written and
  // decoded; a key percent-encoded as a credential parameter's value. Not inside one (a parameter of no credential's
  // name), it withholds the text.
  (() => {
    const address = `https://h.example/feed/me%40h.example/${P24.join("")}/basic.ics`;
    return {
      name: "an address held as written and decoded is cut in place with its written form",
      text: `see ${address} ok`,
      values: [address, decodeURIComponent(address)],
      hides: [P24[0], P24[1]],
      exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "see [redacted] ok"])),
    };
  })(),
  ...[["token", "cb?token=[redacted] ok"], ["note", "[redacted]"]].map(([name, shown]) => ({
    name: `a held value percent-encoded as the value of ?${name}= ${name === "token" ? "is cut in place with it" : "withholds the text"}`,
    text: `cb?${name}=${[...P24.join("")].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("")} ok`,
    values: [P24.join("")],
    hides: ["%5A%71%38%56"],
    exact: { redacted: shown, redactedAnswer: shown, redactSecrets: shown, runFile: shown },
  })),
  // A held value whose part is another held value, cut in place, withholds the text: no part of the longer one shows.
  ...[[P24[1], P24.join("")], [P24.join(""), P24[1]]].map((values) => ({
    name: `a held value split by a line break, its rest another held value (${values[0] === P24[1] ? "the shorter" : "the longer"} named first)`,
    text: `id ${P24[0]}\n${P24[1]} end`,
    values,
    hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
    exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"])),
  })),
  ...[[`id ${P24[1]} end`, "id [redacted] end"], [`id ${P24.join("")} and ${P24[1]} end`, "id [redacted] and [redacted] end"]].map(([text, shown]) => ({
    name: `held values whole, one the other's rest, are each cut in place: ${JSON.stringify(text.slice(0, 12))}`,
    text,
    values: [P24[1], P24.join("")],
    hides: [P24[1]],
    exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown])),
  })),
  // A held value across an answer's first piece edge: its head in a credential parameter the first piece cuts, or the
  // value holding the line break the piece ends at. No piece shows any part of it.
  {
    name: "a held value split at a piece's edge, its head in a credential parameter the piece cut, withholds an answer and a call's result whole",
    text: `${"w ".repeat(4080)}cb?token=${P24[0]}\n${P24[1]} ok ${"y ".repeat(100)}`,
    values: [P24.join("")],
    hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
    exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]" },
  },
  {
    name: "a held value split at a piece's edge, whole in the text, is cut in place (control)",
    text: `${"w ".repeat(4080)}cb?token=${P24.join("")}\n${P24[1].slice(0, 4)} ok`,
    values: [P24.join("")],
    hides: [P24[0].slice(0, 8)],
    exact: Object.fromEntries(["redactedAnswer", "redactedCall", "runFile"].map((name) => [name, `${"w ".repeat(4080)}cb?token=[redacted]\n${P24[1].slice(0, 4)} ok`])),
  },
  {
    name: "a held value holding a line break, whole across two pieces' edge, withholds the text: no piece shows its part",
    text: `${"w ".repeat(4080)}key: ${P24[0]}\n${P24[1]} end ${"y ".repeat(100)}`,
    values: [`${P24[0]}\n${P24[1]}`],
    hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
    exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]" },
  },
  {
    name: "a held value holding a line break, whole in a short text, is cut in place (control)",
    text: `key: ${P24[0]}\n${P24[1]} end`,
    values: [`${P24[0]}\n${P24[1]}`],
    hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
    exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "key: [redacted] end"])),
  },
  // A held value with no whitespace in it, split inside its run at a piece's hard edge: a run of a JSON array's numbers
  // past a piece is cut after its last comma (runCut), here the value's own. Only the view with whitespace gone reads it
  // across the line break the raw pieces are joined with.
  (() => {
    const value = "31415926,1414213562373xQ9kZ";
    // "[" and 1,167 numbers of 6 digits, each with its comma: 8,170 characters, so the value's comma, at 8,178, is the
    // last comma in the first 8,192 characters, and its digits after it run to 8,192.
    const before = `[${Array.from({ length: 1167 }, (_, i) => 100000 + i).join(",")},`;
    const text = `${before}${value},${Array.from({ length: 200 }, (_, i) => 200000 + i).join(",")}]`;
    return {
      name: "a held value with no whitespace in it, split mid-run at a piece's hard edge, withholds an answer and a call's result whole",
      text,
      values: [value],
      hides: [value.slice(0, 8), value.slice(9)],
      exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]", runFile: text.replace(value, "[redacted]") },
    };
  })(),
  ...[[], [CUT_KEY]].map((values) => ({
    name: `the ftp password of 3,000 characters with '",' in it where a call's read stops, ${values.length} held`,
    text: `${"y ".repeat(59_000)}ftp://${login("alice", "prefix")}${"p".repeat(3000)}",${"q".repeat(1000)}@host/${"r".repeat(9000)} end`,
    values,
    hides: ["prefixpp", "pppppppp"],
    exact: { redactedCall: `${"y ".repeat(59_000)}[redacted] end`, redactedAnswer: `${"y ".repeat(59_000)}[redacted] end` },
  })),
  ...[[], [CUT_KEY]].map((values) => ({
    name: `a URL whose authority ends at the next URL's "://" keeps that URL's password whole (socks5 chain), ${values.length} held`,
    text: `${"y ".repeat(59_000)}socks5://h:1080,https://${login("user", "")}${"P".repeat(3000)}",${"s".repeat(9000)}@host.com/x end`,
    values,
    hides: ["PPPPPPPP"],
  })),
  // redactedCall's show contract: values and shapes are checked on the text as it came; the URL scrub only shapes what
  // is shown, so a value the scrub would cut apart is still found whole first.
  ...[
    ["https://api.example.com/v1/login?user=me&pass=Pw7&kq9Lm2xZ8vR4", "Pw7&kq9Lm2xZ8vR4", "https://api.example.com/v1/login?user=…&pass=…"],
    ["https://h.example/hook?c2VjcmV0LXNpZ25pbmcta2V5LTEy==", "secret-signing-key-12", "https://h.example/hook?[redacted]=…"],
    ["https://h.example/files/Pw7kq9Lm#2xZ8vR4/x", "Pw7kq9Lm#2xZ8vR4", "https://h.example/files/[redacted]/x"],
    ["https://h.example/cb?Zq8VbN3xLmT6pR2w\nYk9HsD4fGj7Ac5Ue ok", "Zq8VbN3xLmT6pR2wYk9HsD4fGj7Ac5Ue", "[redacted]"],
    [`https://${login("deploy", "P@ss#word123456")}@git.example.com/repo.git`, "P@ss#word123456", "https[redacted]@git.example.com/repo.git"],
  ].map(([text, key, shows], i) => ({
    name: `redactedCall's show contract, URL case ${i + 1}: checked as it came, then scrubbed`,
    text,
    values: [key],
    hides: [key.slice(0, 8), key.slice(-8)],
    exact: { redactedCall: shows },
  })),
  {
    name: "a held value split by whitespace across the edge of a call's result's pieces",
    text: `${"y ".repeat(4089)} ${CUT_KEY.slice(0, 12)}\n${CUT_KEY.slice(12)}${" the words after it. ".repeat(2000)}`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(12, 20)],
    exact: { redactedCall: "[redacted]", redactedAnswer: "[redacted]", runFile: "[redacted]" },
  },
  {
    name: "a held value whole at the edge of a call's result's pieces is cut in place",
    text: `${"y ".repeat(4089)} ${CUT_KEY}${" the words after it. ".repeat(2000)}`,
    values: [CUT_KEY],
    hides: [CUT_KEY],
    exact: {
      redactedCall: `${"y ".repeat(4089)} [redacted]${" the words after it. ".repeat(2000)}`,
      redactedAnswer: `${"y ".repeat(4089)} [redacted]${" the words after it. ".repeat(2000)}`,
      runFile: `${"y ".repeat(4089)} [redacted]${" the words after it. ".repeat(2000)}`,
    },
  },
  {
    name: "a held value split by a line break just past the head a grader is shown",
    text: `${"y ".repeat(59_994)}${CUT_KEY.slice(0, 16)}\n${CUT_KEY.slice(16)}${"z".repeat(5000)}`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(0, 16)],
    exact: { redactedCall: "[redacted]", redactedAnswer: "[redacted]", runFile: "[redacted]" },
  },
  {
    name: "a held value split by a line break before a run too long to read",
    text: `the key: ${CUT_KEY.slice(0, 16)}\n${CUT_KEY.slice(16)}${"z".repeat(9000)} end`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(0, 16)],
    exact: { redactedCall: "[redacted]", redactedAnswer: "[redacted]", runFile: "[redacted]" },
  },
  (() => {
    const shorter = ["other", "held", "value", "abcdefgh"].join("-");
    const longer = `${["not", "a", "secret", "prefix"].join("-")}-${shorter}`;
    return {
      name: "a longer held value split before a long run, a shorter held value at that run's head",
      text: `the key: ${longer.slice(0, 20)}\n${longer.slice(20)}${"z".repeat(9000)} end`,
      values: [longer, shorter],
      hides: [longer.slice(0, 20)],
      exact: { redactedCall: "[redacted]", redactedAnswer: "[redacted]", runFile: "[redacted]" },
    };
  })(),
  {
    name: "a held value split by a line break where a call's read stops, after a run its pieces took back",
    text: `${"y ".repeat(59_000)}["${"a".repeat(7000)}",${"B".repeat(30_000)} ${"y ".repeat(975)}${SPLIT.slice(0, 40)}\n${SPLIT.slice(40)}${"z".repeat(9000)} end`,
    values: [SPLIT],
    hides: [SPLIT.slice(0, 8)],
  },
  {
    name: "a call's result whose URLs lose their query values shows no held value's prefix past what was read",
    text: `${Array.from({ length: 20 }, () => `https://h.example/p?q=${"a".repeat(5000)} `).join("")}${"y ".repeat(10_000)}https://h.example/u?q=${"b".repeat(6000)} ${"y ".repeat(400)}${SPLIT.slice(0, 40)}\n${SPLIT.slice(40)}${"z".repeat(9000)} end`,
    values: [SPLIT],
    hides: [SPLIT.slice(0, 8)],
  },
  {
    name: "where a call's read stops inside a run cut at a quote, no URL password the stop split shows in part",
    text: `${"y ".repeat(Math.floor((120_000 - 8139) / 2))}{"a":"${"x".repeat(8100)}","u":"https://${login("admin", "hunterTWO-secretpw")}",${"x".repeat(300)}@db.example/"} end ${"w ".repeat(5000)}`,
    values: [["not-a-secret", "p2-key", "0123456789ab"].join("-")],
    hides: ["hunterTWO"],
  },
  ...["+".repeat(400), "%20".repeat(400), "%0A".repeat(200), "%E3%80%80".repeat(100), " ".repeat(20_000_000)].map((pad) => ({
    name: `a held value split where a call's read stops, its rest past ${JSON.stringify(pad.slice(0, 9))} x ${pad.length / (pad.startsWith("%E3") ? 9 : pad.startsWith("%") ? 3 : 1)}`,
    text: `${"y ".repeat(59_940)}${CUT_KEY.slice(0, 16)}\n${pad}${CUT_KEY.slice(16)}${"z".repeat(9000)} end`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(0, 8)],
  })),
  {
    name: "padding of \"+\" longer than a piece where a call's read stops withholds the call's result",
    text: `${"y ".repeat(59_940)}${CUT_KEY.slice(0, 16)}${"+".repeat(20_000)}${CUT_KEY.slice(16)} end`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(0, 8)],
    exact: { redactedCall: "[redacted]" },
  },
  {
    name: "a call's result that shows as almost nothing once its URLs lose their query values is cut short of its end",
    text: ` https://e.com/?x=${"q".repeat(8150)}`.repeat(4000),
    values: [CUT_KEY],
    hides: [],
    entries: ["redactedCall"],
    check: { redactedCall: (shown) => shown.startsWith(" https://e.com/?x=… https://e.com/?x=…") && shown.length < 120_000 },
  },
  ...(() => {
    const ids = Array.from({ length: 2000 }, (_, i) => `id-${i}`);
    const whole = (text) => ({ redactedCall: text, redactedAnswer: text, runFile: text });
    const holding = JSON.stringify({ ids: [...ids.slice(0, 1000), CUT_KEY, ...ids.slice(1000)] });
    return [
      ...[[], [CUT_KEY]].flatMap((values) => [
        { name: `compact JSON of ids past a piece, ${values.length} held`, text: JSON.stringify({ ids }), values, hides: [], exact: whole(JSON.stringify({ ids })) },
        { name: `a JSON array of numbers past a piece, ${values.length} held`, text: JSON.stringify(Array.from({ length: 3000 }, (_, i) => i * 7919)), values, hides: [], exact: whole(JSON.stringify(Array.from({ length: 3000 }, (_, i) => i * 7919))) },
        { name: `compact JSON with a URL with no path, ${values.length} held`, text: JSON.stringify({ url: "https://example.com", ids }), values, hides: [], exact: whole(JSON.stringify({ url: "https://example.com", ids })) },
      ]),
      { name: "compact JSON holding a held value is cut in place", text: holding, values: [CUT_KEY], hides: [CUT_KEY], exact: whole(holding.replace(CUT_KEY, "[redacted]")) },
      {
        name: "a URL's password holding a quote and a comma where a run is cut",
        text: `"${"x".repeat(8100)}https://${login("alice", "prefix")}",rest@host.example/${"z".repeat(3000)}`,
        values: [],
        hides: ["prefix"],
        exact: { redactedCall: "[redacted]", redactedAnswer: "[redacted]" },
      },
      {
        name: "a run cut at a quote that goes on past a piece with no place to cut",
        text: `say "${"x".repeat(8100)}https://${login("alice", "prefix")}",${"r".repeat(9000)}@host end`,
        values: [],
        hides: ["prefix"],
        exact: { redactedCall: "say [redacted] end", redactedAnswer: "say [redacted] end" },
      },
    ];
  })(),
  (() => {
    const monid = `mk_${"7Hq2Lw9Rx4Tz".repeat(3)}`;
    const store = ["store", "value", "0123456789"].join("-");
    return {
      name: "a text file with a saved tool key and a secret store's value has both cut in place",
      text: `key=${monid}\nhook=${store}\nthe rest stays.\n`,
      values: [monid, store],
      hides: [monid, store],
      exact: { runFile: "key=[redacted]\nhook=[redacted]\nthe rest stays.\n", redactSecrets: "key=[redacted]\nhook=[redacted]\nthe rest stays.\n" },
    };
  })(),
  (() => {
    const text = `${"The parallel frontend speeds up builds. ".repeat(375)}With 8 threads, cargo check ran about 2x faster. ${"More on the design. ".repeat(250)}`;
    const page = JSON.stringify({ ok: true, url: "https://blog.example/parallel", status: 200, title: "Faster builds", text, chars: text.length });
    return { name: "a web_fetch page of 20,000 characters is shown whole", text: page, values: [CUT_KEY], hides: [], exact: { redactedCall: page, redactedAnswer: page, runFile: page } };
  })(),
  // A held value found in a view of the text (here percent-decoded) withholds the text only where no cut holds it: a
  // calendar's address is held as written and decoded (calendar/address.ts addressForms), and its decoded form, read in
  // the text's decoded view, comes from the written form the cut takes, so it is cut in place, not withheld.
  (() => {
    const url = "https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics";
    const text = `Subscribe at ${url} for the team's week.`;
    const shown = "Subscribe at [redacted] for the team's week.";
    return {
      name: "a calendar address held as written and decoded is cut in place where it is written",
      text,
      values: addressForms(url),
      hides: ["private-0123456789abcdef", "me%40example.com"],
      exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown])),
    };
  })(),
  // A PEM-like held value with line breaks in it, placed so the first piece of an answer or a call's result ends at
  // its first line break: no piece holds it whole, and no line of it shows.
  (() => {
    // A made-up body (base64 of "fake-body-not-a-real-key"), and its armor built in pieces, as the repo's other key fixtures are.
    const lines = Array.from({ length: 12 }, (_, i) => `${"ZmFrZS1ib2R5LW5vdC1hLXJlYWwta2V5".slice(i % 8)}${String(i).padStart(4, "0")}${"0123456789abcdefABCDEFGHijklmnop".slice(0, 28 + (i % 4))}`);
    const pem = [`-----BEGIN ${"PRIVATE KEY"}-----`, ...lines, `-----END ${"PRIVATE KEY"}-----`].join("\n");
    return {
      name: "a PEM-like held value across the edge of an answer's pieces shows no line of it",
      text: `${"y ".repeat(4050)}${pem}${" the words after it. ".repeat(500)}`,
      values: [pem],
      hides: lines.map((line) => line.slice(0, 12)),
    };
  })(),
  // The piece rule: an answer or a call's result read in pieces (key-refusal.ts) checks a held value's find against the
  // cuts each piece already made, so a value split inside one piece blanks only that piece and the other pieces show;
  // one across a piece's edge withholds the whole text (the cases above).
  {
    name: "a held value split inside one piece blanks only that piece; the other pieces show",
    text: `${"alpha words ".repeat(700)}${CUT_KEY.slice(0, 12)} ${CUT_KEY.slice(12)} ${"omega words ".repeat(2000)}`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(0, 12), CUT_KEY.slice(12, 24)],
    check: Object.fromEntries(["redactedAnswer", "redactedCall"].map((name) => [name, (out) => out.startsWith("alpha words ".repeat(600)) && out.endsWith("omega words ".repeat(600)) && out.includes("[redacted]")])),
  },
  // What an answer or a call's result shows is read whole for a held value: pieces each cut as they should be can still
  // show one together. Here a held value holds the cut marker, and its parts stand on either side of a cut made at the
  // head of the next piece (a held value's, a JWT's), or of an unread run's "[redacted]". The text as it came never holds
  // it, so only the text returned does. "y " x 4085 and "ab12 " put a piece's edge at 8,175, where a long run starts.
  ...(() => {
    const MARK = ["[", "redacted", "]"].join("");
    const b64url = (text) => Buffer.from(text).toString("base64url");
    const jwt = [b64url('{"alg":"HS256","typ":"JWT"}'), b64url('{"sub":"1234567890","name":"probe","iat":1516239022}'), "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".");
    const lead = "y ".repeat(4085);
    const tail = "z ".repeat(50);
    const both = (shown) => ({ redactedAnswer: shown, redactedCall: shown });
    const run = `${"y ".repeat(100)}Qx${"a".repeat(9000)} next ${tail}`;
    return [
      {
        name: "a held value holding the cut marker, its parts on either side of another held value cut at the next piece's head, withholds the text",
        text: `${lead}ab12 ${CUT_KEY} cd34 ${tail}`,
        values: [`ab12${MARK}cd34`, CUT_KEY],
        hides: [CUT_KEY],
        exact: both("[redacted]"),
      },
      {
        name: "a held value holding the cut marker, made in one piece, is withheld (control)",
        text: `see ab12 ${CUT_KEY} cd34 end`,
        values: [`ab12${MARK}cd34`, CUT_KEY],
        hides: [CUT_KEY, "ab12"],
        exact: { ...both("[redacted]"), redactSecrets: "[redacted]", runFile: "[redacted]" },
      },
      {
        name: "a held value holding the cut marker, its parts on either side of a JWT cut at the next piece's head, withholds the text",
        text: `${lead}ab12 ${jwt} cd34 ${tail}`,
        values: [`ab12${MARK}cd34`],
        hides: [jwt.slice(0, 24)],
        exact: both("[redacted]"),
      },
      {
        name: "a held value around a JWT, split by a space at a piece's edge, the JWT cut as a shape, withholds the text",
        text: `${lead}ab12 ${jwt} cd34 ${tail}`,
        values: [`ab12${jwt}cd34`],
        hides: [jwt.slice(0, 24)],
        exact: both("[redacted]"),
      },
      {
        name: "a held value holding the cut marker, from the piece before an unread run, its \"[redacted]\" and the next piece, withholds the text",
        text: run,
        values: [`yy${MARK}next`],
        hides: [],
        exact: both("[redacted]"),
      },
      {
        name: "a held value holding the cut marker whose head is only in an unread run is no held value shown: the text shows with the run as \"[redacted]\"",
        text: run,
        values: [`aaaa${MARK}next`],
        hides: [],
        exact: both(`${"y ".repeat(100)}[redacted] next ${tail}`),
      },
    ];
  })(),
  // A held value whose head is glued to the end of a run too long to read, its rest after the run: the run shows as
  // "[redacted]" and its tail is read with what follows it, so no part of the value shows.
  {
    name: "a held value whose head is glued to the end of a run too long to read, its rest past a line break, withholds the text",
    text: `the key: ${"z".repeat(9000)}${CUT_KEY.slice(0, 16)}\n${CUT_KEY.slice(16)} end`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(16, 24)],
    exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]", runFile: "[redacted]" },
  },
  // The same, with padding the matcher reads as nothing between the head and the run's end: the tail read counts
  // characters as the views see them, so the padding never pushes the head out of it. With no held value in the text,
  // the same layout shows, the run as "[redacted]" (control).
  ...[[ZWSP.repeat(300), "zero-width spaces"], [SHY.repeat(300), "soft hyphens"], [`${String.fromCharCode(92)}n`.repeat(300), "\\n escapes"], ["%E2%80%8B".repeat(300), "%E2%80%8B"]].flatMap(([pad, what]) => [
    {
      name: `a held value whose head is glued to the end of a run too long to read, then ${what}, its rest past a line break, withholds the text`,
      text: `the key: ${"z".repeat(9000)}${CUT_KEY.slice(0, 16)}${pad}\n${CUT_KEY.slice(16)} end`,
      values: [CUT_KEY],
      hides: [CUT_KEY.slice(16, 24)],
      exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]", runFile: "[redacted]" },
    },
    {
      name:
        what === "%E2%80%8B"
          ? `a run too long to read ending in ${what}, with no held value in the text, is withheld whole: its tail read passes its budget`
          : `a run too long to read ending in ${what}, with no held value in the text, shows with the run as "[redacted]" (control)`,
      text: `the key: ${"z".repeat(9000)}${CUT_KEY.slice(0, 16)}${pad}\n${CUT_KEY.slice(16)} end`,
      values: [SPLIT],
      hides: [],
      // Percent-encoded zero-width spaces: the tail read visits 850,788 characters, more than its budget (key-refusal.ts
      // READ_BUDGET, 92 pieces: 753,664), so it gives up and the text is withheld whole. Pinned as it is now.
      exact:
        what === "%E2%80%8B"
          ? { redactedAnswer: "[redacted]", redactedCall: "[redacted]" }
          : { redactedAnswer: `the key: [redacted]\n${CUT_KEY.slice(16)} end`, redactedCall: `the key: [redacted]\n${CUT_KEY.slice(16)} end` },
    },
  ]),
  {
    name: "a held value whose head is glued to the end of a run too long to read, then padding longer than a piece, withholds the text",
    text: `the key: ${"z".repeat(9000)}${CUT_KEY.slice(0, 16)}${ZWSP.repeat(9000)}\n${CUT_KEY.slice(16)} end`,
    values: [CUT_KEY],
    hides: [CUT_KEY.slice(16, 24)],
    exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]", runFile: "[redacted]" },
  },
  (() => {
    const { lines, pem } = fakePem(6);
    return {
      // The block is read with the run it is glued to, to its END line (a piece never ends inside a block), so the run
      // and the block show as one "[redacted]".
      name: "a held PEM-like value whose armor is glued to the end of a run too long to read is read with the run, as \"[redacted]\"",
      text: `${"Z".repeat(20_000)}${pem} end`,
      values: [pem],
      hides: lines.map((line) => line.slice(0, 12)),
      exact: { redactedAnswer: "[redacted] end", redactedCall: "[redacted] end" },
    };
  })(),
  // A private key block with no held value to cut it by, across the edge of an answer's or a call's result's first
  // piece: the piece ends before its BEGIN line, so the block is read whole in the next piece and cut whole, and the
  // text after it shows. A block longer than a piece is read as one run and shown as "[redacted]".
  ...(() => {
    const label = ["RSA", "PRIVATE", "KEY"].join(" ");
    const block = (size) => {
      const body = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7919 + 13) % 256)).toString("base64").match(/.{1,64}/g);
      return { body, pem: [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`].join("\n") };
    };
    const after = " the words after it.".repeat(600);
    const both = (shown) => ({ redactedAnswer: shown, redactedCall: shown });
    return [
      ...[[1190, "a key's block"], [9000, "a block longer than a piece"]].map(([size, what]) => {
        const { body, pem } = block(size);
        const text = `${"y ".repeat(3500)}${pem}\n${after}`;
        return {
          name: `${what}, no value held, across the edge of an answer's first piece is cut whole; the text after it shows`,
          text,
          values: [CUT_KEY],
          hides: [...body.slice(1).map((line) => line.slice(0, 16)), `-----END ${label}`],
          exact: both(`${"y ".repeat(3500)}[redacted]\n${after}`),
        };
      }),
    ];
  })(),
  // A held value of many lines is found by its parts too: each line of 40 characters or more, and its body (the lines
  // between its armor) with the line breaks gone. So the first lines of a held key, or its body without the armor,
  // show no line; and a held JSON value's multi-line string (a service account's private key) is held as itself.
  ...(() => {
    const { lines, pem } = fakePem(25);
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const account = JSON.stringify({
      type: "service_account",
      project_id: "made-up-project",
      private_key_id: "0123456789abcdef0123456789abcdef01234567",
      private_key: `${pem}\n`,
      client_email: "probe@made-up-project.iam.gserviceaccount.com",
      client_id: "123456789012345678901",
    }, null, 2);
    return [
      // Its header starts a private key block with no END line, cut through its lines to the text's end, the lines' own
      // cuts inside it.
      {
        name: "the first 11 lines of a held PEM-like value (head -n 11) show no line of it",
        text: `$ head -n 11 key.pem\n${pem.split("\n").slice(0, 11).join("\n")}\n`,
        values: [pem],
        hides: lines.slice(0, 10).map((line) => line.slice(0, 12)),
        exact: all("$ head -n 11 key.pem\n[redacted]"),
      },
      {
        name: "a held PEM-like value's body, its armor stripped, shows no line of it",
        text: `body:\n${lines.join("\n")}\n`,
        values: [pem],
        hides: lines.map((line) => line.slice(0, 12)),
        exact: all(`body:\n${Array(25).fill("[redacted]").join("\n")}\n`),
      },
      {
        name: "a held service account JSON's private key, printed alone, shows no line of it",
        text: `$ jq -r .private_key sa.json\n${pem}\n`,
        values: [account],
        hides: lines.map((line) => line.slice(0, 12)),
      },
    ];
  })(),
  // A held key's last body line is mostly shorter than a part's line (40), so it is held with its END line, as written:
  // the last two lines printed (`tail -n 2`) are cut. The END line alone is no part, and shows (control).
  ...(() => {
    const { lines } = fakePem(10);
    const last = "ZmFrZS1ib2R5LW5vdC1hLXJlYWw=";
    const end = `-----END ${"PRIVATE KEY"}-----`;
    const pem = [`-----BEGIN ${"PRIVATE KEY"}-----`, ...lines, last, end].join("\n");
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    return [
      {
        name: "the last two lines of a held PEM-like value (tail -n 2), its last body line short, show neither",
        text: `$ tail -n 2 key.pem\n${last}\n${end}\n`,
        values: [pem],
        hides: [last.slice(0, 12)],
        exact: all("$ tail -n 2 key.pem\n[redacted]\n"),
      },
      {
        name: "the END line of a held PEM-like value, printed alone, shows (control)",
        text: `$ tail -n 1 key.pem\n${end}\n`,
        values: [pem],
        hides: [],
        exact: all(`$ tail -n 1 key.pem\n${end}\n`),
      },
    ];
  })(),
  // A held JSON value's own lines are no parts of it: a service account as Google serves it, pretty-printed, has its
  // public strings on lines of their own, and a text that names them, as written or minified, shows. Its private key's
  // lines are still parts (heldFields holds the key, and its lines are its parts).
  ...(() => {
    const { lines, pem } = fakePem(25);
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const account = JSON.stringify({
      type: "service_account",
      project_id: "made-up-project",
      private_key_id: "0123456789abcdef0123456789abcdef01234567",
      private_key: `${pem}\n`,
      client_email: "probe@made-up-project.iam.gserviceaccount.com",
      client_id: "123456789012345678901",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    }, null, 2);
    const pretty = account.split("\n").filter((line) => /"(?:auth_uri|token_uri|auth_provider_x509_cert_url|client_email)"/.test(line)).join("\n");
    const minified = '{"type":"service_account","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs"}';
    return [
      {
        name: "a held pretty-printed service account's public lines, printed as written, show",
        text: `$ grep _ur sa.json\n${pretty}\n`,
        values: [account],
        hides: [],
        exact: all(`$ grep _ur sa.json\n${pretty}\n`),
      },
      {
        name: "a held pretty-printed service account's public strings, in minified JSON, show",
        text: `the docs' example: ${minified} ok`,
        values: [account],
        hides: [],
        exact: all(`the docs' example: ${minified} ok`),
      },
      {
        name: "a held pretty-printed service account's private key, printed alone, shows no line of it",
        text: `$ jq -r .private_key sa.json\n${pem}\n`,
        values: [account],
        hides: lines.map((line) => line.slice(0, 12)),
      },
    ];
  })(),
  // A held JSON value's string whose key names a credential (the URL rule's names, the whole key) is held as itself,
  // nested or not: an OAuth client's secret, printed alone, is cut. Its other one-line strings (an id, its URLs) are no
  // secret and stay.
  ...(() => {
    const secret = ["made", "up", "client", "secret", "q8VxR2mT7kPz"].join("-");
    const clientId = "123456789012-madeupclientid.apps.googleusercontent.com";
    const client = JSON.stringify({
      installed: {
        client_id: clientId,
        project_id: "made-up-project",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        client_secret: secret,
        redirect_uris: ["http://localhost"],
      },
    });
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const shown = `auth_uri: https://accounts.google.com/o/oauth2/auth\ntoken_uri: https://oauth2.googleapis.com/token\nclient_id: ${clientId}\n`;
    return [
      {
        name: "a held OAuth client JSON's client_secret, printed alone, is cut",
        text: `$ jq -r .installed.client_secret client.json\n${secret}\n`,
        values: [client],
        hides: [secret.slice(-12)],
        exact: all("$ jq -r .installed.client_secret client.json\n[redacted]\n"),
      },
      {
        name: "a held OAuth client JSON's auth_uri, token_uri and client_id, printed alone, show (control)",
        text: shown,
        values: [client],
        hides: [],
        exact: all(shown),
      },
    ];
  })(),
  // A held JSON value's string is held by its key's name, its separators dropped and lowered: one that names a secret,
  // a password, a token, a private value, a credential or an API key, or ends in "key" (an AWS secret access key, an STS
  // session token, a webhook's signing secret, a one-line private key), but none that names a public thing (an id, a
  // URI or URL, a type, an email, an endpoint, an expiry), a public key, or a token that is no secret (a page's, the
  // next page's, a token's type). A JWK's private members (d, p, q, dp, dq, qi, k) are held beside its "kty" only. Each printed alone
  // (`jq -r`) is cut, or shows.
  ...(() => {
    const made = (name) => ["made", "up", name, "R2mTq8Vx7kPz"].join("-");
    const held = {
      Credentials: { AccessKeyId: "MADEUPACCESSKEYID0001", SecretAccessKey: made("secret-access-key"), SessionToken: made("session-token"), Expiration: "2026-11-24T12:00:00Z" },
      aws_secret_access_key: made("aws-secret"),
      secret_key: made("secret-key"),
      signing_secret: made("signing"),
      private_key: made("ed25519-seed"),
      public_key: made("ed25519-public"),
      okp: { kty: "OKP", crv: "Ed25519", x: made("okp-public-x"), d: made("okp-d") },
      oct: { kty: "oct", k: made("oct-k") },
      rsa: { kty: "RSA", n: made("rsa-public-n"), e: "AQAB", d: made("rsa-d"), p: made("rsa-p"), q: made("rsa-q"), dp: made("rsa-dp"), dq: made("rsa-dq"), qi: made("rsa-qi") },
      client_id: "123456789012-madeupclientid.apps.googleusercontent.com",
      token_uri: "https://oauth2.googleapis.com/token",
      page_token: made("page-token"),
      next_token: made("next-token"),
      token_type: "urn:ietf:params:oauth:token-type:access_token",
      notes: { d: made("no-kty-d") },
    };
    const value = JSON.stringify(held);
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const at = (path) => path.split(".").reduce((node, key) => node[key], held);
    const cut = ["Credentials.SecretAccessKey", "Credentials.SessionToken", "aws_secret_access_key", "secret_key", "signing_secret", "private_key", "okp.d", "oct.k", "rsa.d", "rsa.p", "rsa.q", "rsa.dp", "rsa.dq", "rsa.qi"];
    const shown = ["Credentials.AccessKeyId", "client_id", "token_uri", "page_token", "next_token", "token_type", "public_key", "okp.x", "rsa.n", "notes.d"];
    return [
      ...cut.map((path) => ({
        name: `a held JSON value's ${path}, printed alone, is cut`,
        text: `$ jq -r .${path} held.json\n${at(path)}\n`,
        values: [value],
        hides: [at(path).slice(-12)],
        exact: all(`$ jq -r .${path} held.json\n[redacted]\n`),
      })),
      ...shown.map((path) => ({
        name: `a held JSON value's ${path}, printed alone, shows (control)`,
        text: `$ jq -r .${path} held.json\n${at(path)}\n`,
        values: [value],
        hides: [],
        exact: all(`$ jq -r .${path} held.json\n${at(path)}\n`),
      })),
    ];
  })(),
  // An array's items have no key: a one-line string in an array is not held by the key the array is under, only by
  // the line-break rule.
  ...(() => {
    const labels = ["made-up-label-one", "made-up-label-two"];
    const secret = ["made", "up", "client", "secret", "R2mT7kPzq8Vx"].join("-");
    const held = JSON.stringify({ secret: labels, client_secret: secret });
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const shown = `$ jq -r '.secret[]' held.json\n${labels.join("\n")}\n`;
    return [
      {
        name: "a held JSON value's one-line strings in an array under a credential key, printed alone, show (control)",
        text: shown,
        values: [held],
        hides: [],
        exact: all(shown),
      },
    ];
  })(),
  // A held value with line breaks written in JSON: escaped once ("\n"), it is cut in place where it stands; escaped
  // twice (JSON in a JSON string, "\\n"), or with its line breaks written "\r\n", it is found in the text decoded and
  // withholds the text. A PEM-like one is a private key block, cut in place from its BEGIN line to its END line however
  // its line breaks are escaped, so the view finds it inside that cut; a value of short lines and no armor is cut by no
  // shape, and withholds.
  ...(() => {
    const { lines, pem } = fakePem(6);
    const short = ["made-up-line-one", "made-up-line-two", "made-up-line-six"];
    const note = short.join("\n");
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    return [
      {
        name: "a held PEM-like value in JSON, escaped once, is cut in place where it stands (control)",
        text: JSON.stringify({ private_key: pem }),
        values: [pem],
        hides: lines.map((line) => line.slice(0, 12)),
        exact: all('{"private_key":"[redacted]"}'),
      },
      {
        name: "a held PEM-like value in JSON in a JSON string, its line breaks escaped twice, is cut in place as a private key block",
        text: JSON.stringify({ out: JSON.stringify({ private_key: pem }) }),
        values: [pem],
        hides: lines.map((line) => line.slice(0, 12)),
        exact: all(JSON.stringify({ out: JSON.stringify({ private_key: "[redacted]" }) })),
      },
      {
        name: "a held PEM-like value in JSON, its line breaks written as \\r\\n, is cut in place as a private key block",
        text: JSON.stringify({ private_key: pem.replaceAll("\n", "\r\n") }),
        values: [pem],
        hides: lines.map((line) => line.slice(0, 12)),
        exact: all('{"private_key":"[redacted]"}'),
      },
      {
        name: "a held value of short lines in JSON in a JSON string, its line breaks escaped twice, withholds the text",
        text: JSON.stringify({ out: JSON.stringify({ note }) }),
        values: [note],
        hides: short,
        exact: all("[redacted]"),
      },
      {
        name: "a held value of short lines in JSON, its line breaks written as \\r\\n, withholds the text",
        text: JSON.stringify({ note: note.replaceAll("\n", "\r\n") }),
        values: [note],
        hides: short,
        exact: all("[redacted]"),
      },
    ];
  })(),
  // A held value holding a backslash before a character an escape could start with ("n", "u" and four hex digits),
  // written by a JSON writer: its backslash escaped ("\", "\\"), the character after it as it stands. Read one level
  // deep, it is the held value; read two levels deep, the escaped backslash and the character after it are one escape,
  // and the value is gone. So the text is read both ways, and withheld.
  ...(() => {
    const B = String.fromCharCode(92);
    return [
      ["a backslash written \\u005c, then n", `held: abcd${B}u005cnefgh ok`, `abcd${B}nefgh`],
      ["a backslash written \\\\, then n, beside a \\u0041", `held: abcd${B}${B}nef${B}u0041gh ok`, `abcd${B}nefAgh`],
      ["a backslash written \\u005c, then u0041", `held: x-made-up${B}u005cu0041y ok`, `x-made-up${B}u0041y`],
    ].map(([what, text, value]) => ({
      name: `a held value holding a backslash, in JSON with ${what}, withholds the text`,
      text,
      values: [value],
      hides: ["abcd", "made-up"],
      exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"])),
    }));
  })(),
  // A character that renders as nothing (a default-ignorable code point: a zero-width space, a soft hyphen) between a
  // held value's characters hides it from no view: the views drop it, as they drop whitespace. A text that holds such
  // characters and no held value shows as it came.
  ...[["a zero-width space", ZWSP], ["a soft hyphen", SHY]].map(([what, mark]) => ({
    name: `a held value with ${what} between each of its characters withholds the text`,
    text: `v=${[...CUT_KEY].join(mark)} ok`,
    values: [CUT_KEY],
    hides: [[...CUT_KEY.slice(14, 22)].join(mark)],
    exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"])),
  })),
  // A held value that itself holds such a character is held without it too: the needles drop it, as the views do.
  {
    name: "a held value holding a zero-width space, printed without it, does not show",
    text: `the value: made-up-held-value-q8VxR2mT7kPz ok`,
    values: [`made-up-held-${ZWSP}value-q8VxR2mT7kPz`],
    hides: ["value-q8VxR2mT7kPz"],
  },
  (() => {
    const text = `co${SHY}op${SHY}er${SHY}a${SHY}tion, a${ZWSP}zero${ZWSP}width${ZWSP}join, and ${BOM}a byte order mark stay as they came`;
    return {
      name: "a text with characters that render as nothing and no held value shows as it came (control)",
      text,
      values: [CUT_KEY],
      hides: [],
      exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, text])),
    };
  })(),
  // A control character that is no whitespace (U+0000-0008, U+000E-001F, U+007F-009F: a NUL, an escape, a delete, a
  // C1 control) renders as nothing too: between a held value's halves it hides the value from no view, as it stands, in
  // a JSON string as JSON.stringify writes it (once, and twice: JSON in JSON), as JSON's \u escape in prose,
  // percent-encoded, as an HTML character reference, as Python's \x escape in a single-quoted dict, and between each of
  // the value's characters. A text that holds such characters and no held value shows as it came, and so does one whose
  // control stands after a held value's head with no rest after it.
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    const hex = (code, width) => code.toString(16).padStart(width, "0");
    return [0x00, 0x01, 0x08, 0x0e, 0x1b, 0x1f, 0x7f, 0x85, 0x9f].flatMap((code) => {
      const control = String.fromCharCode(code);
      const at = `U+${hex(code, 4).toUpperCase()}`;
      return [
        [`${at} as it stands`, `x ${H}${control}${R} y`],
        [`${at} in a JSON string as JSON.stringify writes it`, JSON.stringify({ note: `see ${H}${control}${R} more` })],
        [`${at} in JSON written in a JSON string`, JSON.stringify({ out: JSON.stringify({ note: `see ${H}${control}${R} more` }) })],
        [`${at} as JSON's \\u escape in prose`, `x ${H}${B}u${hex(code, 4)}${R} y`],
        [`${at} percent-encoded`, `x ${H}${encodeURIComponent(control)}${R} y`],
        [`${at} as Python's \\x escape in a single-quoted dict`, `{'a': 'see ${H}${B}x${hex(code, 2)}${R} more'}`],
        [`${at} between each of its characters`, `v=${[...H, ...R].join(control)} ok`],
        // A browser reads "&#0;" as U+FFFD, which shows, so it is no control (match.ts entityAt).
        ...(code > 0 ? [[`${at} as an HTML character reference`, `x ${H}&#x${code.toString(16)};${R} y`]] : []),
      ].map(([what, text]) => ({ name: `a held value split by a control character, ${what}, withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
    });
  })(),
  ...(() => {
    const [nul, soh, esc, us, del, nel] = [0x00, 0x01, 0x1b, 0x1f, 0x7f, 0x85].map((code) => String.fromCharCode(code));
    const [H] = P24;
    return [
      ["controls between words and no held value", `a${nul}b${soh}c ${esc}[0m d${us}e${del} f${nel}g end`],
      ["controls after a held value's head with no rest after them", `x ${H}${nul}${soh}zzzzzzzz y`],
      ["a control after a held value's head with no rest after it, in a JSON string", JSON.stringify({ note: `see ${H}${nul}zzzzzzzz more` })],
    ].map(([what, text]) => ({
      name: `a text with ${what} shows as it came (control)`,
      text,
      values: [P24.join("")],
      hides: [],
      exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, text])),
    }));
  })(),
  // A terminal sequence shows as nothing where a terminal or a log viewer renders it: a held value split by one reads
  // whole there, so it withholds the text, whether the sequence is a CSI (ESC "[", parameters, intermediates, a final
  // byte: a colour, a cursor move, a private mode), an OSC (ESC "]" to a BEL or ESC and a backslash: a title, a hyperlink), the
  // 8-bit CSI and OSC (U+009B, U+009D, to U+009C), or a two-character escape (ESC "7", ESC "(" "B"), as it stands, in a
  // JSON string (once, and twice), as JSON's \u escape in prose, as Python's \x escape in a single-quoted dict,
  // percent-encoded, as an HTML character reference, and before each of the value's characters. So does a backspace
  // that strikes a character out: the terminal shows what comes after it in its place.
  ...(() => {
    const [H, R] = P24;
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    const E = "\u001b";
    return [
      ["a CSI colour reset as it stands", `x ${H}${E}[0m${R} y`],
      ["a CSI colour with parameters as it stands", `x ${H}${E}[1;38;5;196m${R} y`],
      ["a CSI private mode as it stands", `x ${H}${E}[?25l${R} y`],
      ["a CSI with an intermediate byte as it stands", `x ${H}${E}[2 q${R} y`],
      ["an OSC title ended by a BEL", `x ${H}${E}]0;build log \u0007${R} y`],
      ["an OSC hyperlink ended by ESC and a backslash", `x ${H}${E}]8;;https://example.test/a${E}\\${R} y`],
      ["an 8-bit CSI", `x ${H}\u009b31m${R} y`],
      ["an 8-bit OSC ended by U+009C", `x ${H}\u009d0;title\u009c${R} y`],
      ["a two-character escape", `x ${H}${E}7${R} y`],
      ["a character set designation", `x ${H}${E}(B${R} y`],
      ["a CSI colour in a JSON string", JSON.stringify({ note: `see ${H}${E}[31m${R} more` })],
      ["a CSI colour in JSON written in a JSON string", JSON.stringify({ out: JSON.stringify({ note: `see ${H}${E}[31m${R} more` }) })],
      ["a CSI colour as JSON's \\u escape in prose", `x ${H}\\u001b[0m${R} y`],
      ["a CSI colour as Python's \\x escape in a single-quoted dict", `{'a': 'see ${H}\\x1b[0m${R} more'}`],
      ["a CSI colour percent-encoded", `x ${H}%1B%5B0m${R} y`],
      ["a CSI colour with its ESC as an HTML character reference", `x ${H}&#x1b;[0m${R} y`],
      ["a CSI colour before each of its characters", `v=${[...H, ...R].map((char, i) => `${E}[3${i % 8}m${char}`).join("")}${E}[0m ok`],
      ["a backspace striking out a character", `x ${H}Z\b${R} y`],
      ["two backspaces striking out two characters", `x ${H}__\b\b${R} y`],
    ].map(([what, text]) => ({ name: `a held value split by a terminal sequence, ${what}, withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  // A terminal ignores a NUL or a DEL inside a sequence and runs any other C0 control there (a backspace moves back)
  // without ending the sequence; CAN (U+0018) or SUB (U+001A) aborts it, and it shows as nothing. A control a view
  // drops, as it stands or as a view decodes it, takes no place on screen either: a backspace after it strikes out the
  // character before it. A held value split by any of these withholds the text.
  ...(() => {
    const [H, R] = P24;
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    const E = "\u001b";
    return [
      ["a NUL inside a CSI colour as it stands", `x ${H}${E}[0\u0000m${R} y`],
      ["a NUL inside a CSI colour in a JSON string", JSON.stringify({ note: `see ${H}${E}[0\u0000m${R} more` })],
      ["a NUL inside a CSI colour, percent-encoded", `x ${H}%1B%5B0%00m${R} y`],
      ["a NUL inside a CSI colour as Python's \\x escape in a single-quoted dict", `{'a': 'see ${H}\\x1b[0\\x00m${R} more'}`],
      ["a U+0001 inside a CSI colour", `x ${H}${E}[0\u0001m${R} y`],
      ["a DEL inside a CSI colour", `x ${H}${E}[0\u007fm${R} y`],
      ["a NUL inside an OSC title ended by a BEL", `x ${H}${E}]0;build\u0000 log\u0007${R} y`],
      ["a CSI aborted by a CAN", `x ${H}${E}[0\u0018${R} y`],
      ["a CSI aborted by a SUB", `x ${H}${E}[1;3\u001a${R} y`],
      ["a backspace inside a CSI, striking out the character before it", `x ${H}Z${E}[0\bm${R} y`],
      ["a backspace after a NUL, striking out the character before the NUL", `x ${H}Z\u0000\b${R} y`],
      ["a backspace after a zero-width space, striking out the character before it", `x ${H}Z\u200b\b${R} y`],
      // A character that shows as a blank or a box takes a cell, though the views drop it: two backspaces strike out it
      // and the character before it.
      ["two backspaces after a braille blank", `x ${H}Z\u2800\b\b${R} y`],
      ["two backspaces after a space", `x ${H}Z \b\b${R} y`],
      ["two backspaces after a no-break space", `x ${H}Z\u00a0\b\b${R} y`],
      ["two backspaces after a private use character", `x ${H}Z\ue000\b\b${R} y`],
      ["two backspaces after U+FFFE", `x ${H}Z\ufffe\b\b${R} y`],
      // A printable character past ASCII inside a CSI does not end it: the terminal ignores the rest to its final byte.
      ["a CSI colour with a character past ASCII inside", `x ${H}${E}[0\u00e9m${R} y`],
      ["a CSI colour with a braille blank inside", `x ${H}${E}[0\u2800m${R} y`],
    ].map(([what, text]) => ({ name: `a held value split by a terminal sequence, ${what}, withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  // Normalization reads past a terminal control as a reader does: a held value with a precomposed Hangul syllable, its
  // conjoining jamo split by a BEL (dropped, as any control is) or by a CSI colour (gone on screen), withholds the text.
  // A backspace strikes out a whole character: one past U+FFFF (a surrogate pair) goes with both halves. Jamo split by a
  // backspace read whole where it is dropped, as before terminal readings.
  ...(() => {
    const [H, R] = P24;
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    const syllable = `${H}가${R}`;
    return [
      { what: "conjoining jamo split by a BEL, the value precomposed", text: `x ${H}ᄀ\u0007ᅡ${R} y`, value: syllable },
      { what: "conjoining jamo split by a CSI colour, the value precomposed", text: `x ${H}ᄀ\u001b[0mᅡ${R} y`, value: syllable },
      { what: "a backspace striking out a character past U+FFFF", text: `x ${H}\u{10400}\b${R} y`, value: P24.join("") },
      { what: "two backspaces striking out a character past U+FFFF and the one before it", text: `x ${H}Z\u{10400}\b\b${R} y`, value: P24.join("") },
      // On screen the backspace strikes out the first jamo; with it dropped as a control, the jamo compose.
      { what: "conjoining jamo split by a backspace, the value precomposed", text: `x ${H}\u1100\b\u1161${R} y`, value: syllable },
    ].map(({ what, text, value }) => ({ name: `a held value read across a terminal control, ${what}, withholds the text`, text, values: [value], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  // Controls: coloured output with no held value shows as it came; a held value coloured whole is cut in place, its
  // colours kept; a backspace that strikes out a held value's own character leaves no held value on screen and shows as
  // it came; and a held value split by an ESC and a letter it would read as no sequence's (as the views read any lone
  // control) still withholds the text.
  ...(() => {
    const [H, R] = P24;
    const V = P24.join("");
    const E = "\u001b";
    const ls = `${E}[0m${E}[01;34mbin${E}[0m  ${E}[01;32mrun.sh${E}[0m  ${E}[01;31mdata.tar.gz${E}[0m \n`;
    const same = (text) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, text]));
    const coloured = `${E}[31m${V}${E}[0m done`;
    const cut = `${E}[31m[redacted]${E}[0m done`;
    return [
      { name: "coloured output with no held value shows as it came (control)", text: ls, values: [V], hides: [], exact: same(ls) },
      { name: "a held value coloured whole is cut in place, its colours kept (control)", text: coloured, values: [V], hides: [H.slice(0, 8), R.slice(0, 8)], exact: { redacted: cut, redactedAnswer: cut, redactSecrets: cut, runFile: cut } },
      { name: "a backspace striking out the last character of a held value's head, its rest after, shows as it came (control)", text: `x ${H}\b${R.slice(0, 4)}zzzz y`, values: [V], hides: [], exact: same(`x ${H}\b${R.slice(0, 4)}zzzz y`) },
      { name: "a held value split by an ESC and its rest's first letter withholds the text (control)", text: `x ${H}${E}${R} y`, values: [V], hides: [H.slice(0, 8), R.slice(0, 8)], exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"])) },
    ];
  })(),
  // More characters that show as a box, a blank or nothing: U+FFFE, the interlinear annotation characters
  // (U+FFF9-FFFB), the noncharacters U+FDD0-FDEF, private use (U+E000-F8FF), the braille blank (U+2800, which shows as
  // a space and is no whitespace), and a lone surrogate. Between a held value's halves each hides it from no view: as it
  // stands, in a JSON string as JSON.stringify writes it (a lone surrogate as its \u escape), as JSON's \u escape in
  // prose, percent-encoded and as an HTML character reference where it has those forms, and between each of the value's
  // characters, it withholds the text.
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    const hex4 = (code) => code.toString(16).padStart(4, "0");
    return [0xfffe, 0xfff9, 0xfffa, 0xfffb, 0xfdd0, 0xfdef, 0xe000, 0xf8ff, 0x2800, 0xd800, 0xdbff, 0xdc00, 0xdfff].flatMap((code) => {
      const char = String.fromCharCode(code);
      const at = `U+${hex4(code).toUpperCase()}`;
      const lone = code >= 0xd800 && code <= 0xdfff;
      return [
        [`${at} as it stands`, `x ${H}${char}${R} y`],
        [`${at} in a JSON string as JSON.stringify writes it`, JSON.stringify({ note: `see ${H}${char}${R} more` })],
        [`${at} as JSON's \\u escape in prose`, `x ${H}${B}u${hex4(code)}${R} y`],
        [`${at} between each of its characters`, `v=${[...H, ...R].join(char)} ok`],
        // A lone surrogate has no UTF-8 bytes, and a browser reads its reference as U+FFFD, which shows.
        ...(lone ? [] : [[`${at} percent-encoded`, `x ${H}${encodeURIComponent(char)}${R} y`], [`${at} as an HTML character reference`, `x ${H}&#x${hex4(code)};${R} y`]]),
      ].map(([what, text]) => ({ name: `a held value split by a character that shows as a box or a blank, ${what}, withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
    });
  })(),
  // Controls: a character past U+FFFF (two surrogates, as they stand or as two \u escapes) is no lone surrogate: a
  // held value holding one is cut in place whole, and a text of such characters, private use characters and braille
  // with no held value shows as it came.
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const V = `${H}\u{1F600}${R}`;
    const same = (text) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, text]));
    const plain = `x ${V} y`;
    const words = `see \u{1F600} and \uE000\uF8FF in \u2801\u2803\u2800\u2809 done`;
    return [
      { name: "a held value holding a character past U+FFFF is cut in place whole (control)", text: plain, values: [V], hides: [H.slice(0, 8), R.slice(0, 8)], exact: { redacted: "x [redacted] y", redactedAnswer: "x [redacted] y", redactSecrets: "x [redacted] y", runFile: "x [redacted] y" } },
      { name: "a held value holding a character past U+FFFF, written as two \\u escapes in prose, withholds the text (control)", text: `x ${H}${B}ud83d${B}ude00${R} y`, values: [V], hides: [H.slice(0, 8), R.slice(0, 8)], exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"])) },
      { name: "a text of characters past U+FFFF, private use characters and braille, with no held value, shows as it came (control)", text: words, values: [P24.join("")], hides: [], exact: same(words) },
    ];
  })(),
  // U+FFFF, a noncharacter, shows as a box at most, so a reader still reads a held value split by one: as it stands, in
  // a JSON string (JSON.stringify keeps it as it is; once, and twice: JSON in JSON), as JSON's \uffff escape in prose
  // and in a JSON string, percent-encoded (its UTF-8 bytes), as an HTML character reference, and between each of the
  // value's characters, it withholds the text. Only the separator a join puts between its passes separates (match.ts
  // SEPARATOR). A text with U+FFFF and no held value shows as it came; so does one with U+FFFF after a held value's head
  // and no rest; and a held value whole beside U+FFFF, or two finds with U+FFFF between them, in prose or in JSON
  // strings, is cut in place, the U+FFFF kept where it stood.
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const N = "\uffff";
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    return [
      ["as it stands", `x ${H}${N}${R} y`],
      ["in a JSON string as JSON.stringify writes it", JSON.stringify({ note: `see ${H}${N}${R} more` })],
      ["in JSON written in a JSON string", JSON.stringify({ out: JSON.stringify({ note: `see ${H}${N}${R} more` }) })],
      ["as JSON's \\u escape in prose", `x ${H}${B}uffff${R} y`],
      ["as JSON's \\u escape in a JSON string", `{"note":"see ${H}${B}uFFFF${R} more"}`],
      ["percent-encoded", `x ${H}%EF%BF%BF${R} y`],
      ["as an HTML character reference", `x ${H}&#xffff;${R} y`],
      ["as a decimal HTML character reference", `x ${H}&#65535;${R} y`],
      ["between each of its characters", `v=${[...H, ...R].join(N)} ok`],
      ["in one of a dict's values written in a JSON string", JSON.stringify({ args: `{'a': 'see ${H}${N}${R} more'}` })],
    ].map(([what, text]) => ({ name: `a held value split by U+FFFF, ${what}, withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  ...(() => {
    const [H] = P24;
    const N = "\uffff";
    return [
      ["U+FFFF between words and no held value", `a${N}b c${N}${N}d end`],
      ["U+FFFF after a held value's head with no rest after it", `x ${H}${N}zzzzzzzz y`],
      ["U+FFFF after a held value's head with no rest after it, in a JSON string", JSON.stringify({ note: `see ${H}${N}zzzzzzzz more` })],
    ].map(([what, text]) => ({
      name: `a text with ${what} shows as it came (control)`,
      text,
      values: [P24.join("")],
      hides: [],
      exact: Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, text])),
    }));
  })(),
  ...(() => {
    const V = P24.join("");
    const N = "\uffff";
    return [
      ["in prose", `see ${V}${N}${V} and a${N}b`, `see [redacted]${N}[redacted] and a${N}b`],
      ["in JSON strings", `{"a":"${V}${N}${V}","b":"${N}${V}"}`, `{"a":"[redacted]${N}[redacted]","b":"${N}[redacted]"}`],
    ].map(([what, text, out]) => ({
      name: `a held value whole beside U+FFFF, ${what}, is cut in place and the U+FFFF kept (control)`,
      text,
      values: [V],
      hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
      exact: { redacted: out, redactedAnswer: out, redactSecrets: out, runFile: out },
    }));
  })(),
  // The #3626 review's escaped splits, each a named guard: a held value split by one of JSON's one-character escapes
  // written as its two characters ("\n", "\t", "\""), a held value written as JSON's \u escapes twice (JSON in JSON),
  // and one split by a zero-width space or a soft hyphen, as it is or escaped. Each withholds the text.
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const twice = [...P24.join("")].map((char) => `${B}${B}u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    return [
      ["a held value split by JSON's \\n written as two characters", `token ${H}${B}n${R} end`],
      ["a held value split by JSON's \\t written as two characters", `token ${H}${B}t${R} end`],
      ["a held value split by JSON's \\\" written as two characters", `token ${H}${B}"${R} end`],
      ["a held value written as JSON's \\u escapes twice (\\\\u005a...)", `x ${twice} y`],
      ["a held value split by a zero-width space", `x ${H}${ZWSP}${R} y`],
      ["a held value split by a soft hyphen", `x ${H}${SHY}${R} y`],
      ["a held value split by an escaped zero-width space (\\u200b)", `x ${H}${B}u200b${R} y`],
      ["a held value split by an escaped soft hyphen (\\u00ad)", `x ${H}${B}u00ad${R} y`],
    ].map(([what, text]) => ({ name: `guard: ${what} withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  // A held value split across two strings of a JSON text (P1-B): each string read alone shows half, and the JSON's
  // punctuation between them is no whitespace any view drops. The join view reads the strings' contents joined (the
  // values, the property names, and both), so no split across them shows, whatever tool wrote the text. A held value
  // whole in one string is cut in place, and the JSON still parses (control).
  ...(() => {
    const [H, R] = P24;
    const all = (shown, but = []) => Object.fromEntries(Object.keys(ENTRIES).filter((name) => !but.includes(name)).map((name) => [name, shown]));
    const split = [
      ["two values of a non-web tool's result", JSON.stringify({ items: [{ title: `see ${H}`, snippet: `${R} more` }] })],
      ["the url and the reason of web_fetch's refused answer", JSON.stringify({ ok: false, url: `https://h.example/${H}`, refused: `${R} is not allowed` })],
      ["two arguments of a call", JSON.stringify({ command: `echo ${H}`, note: R })],
      ["a property name and its value", JSON.stringify({ [H]: R })],
      ["two property names", JSON.stringify({ [H]: "x", [R]: "y" })],
      ["an escaped quote inside one string", JSON.stringify({ note: `see ${H}"${R} more` })],
      ["two strings of JSON written in a JSON string", JSON.stringify({ out: JSON.stringify([H, R]) })],
      ["two values of JSON written in a JSON string, a property name between them", JSON.stringify({ out: JSON.stringify({ title: `see ${H}`, snippet: `${R} more` }) })],
      ["a string and the line after the JSON", `${JSON.stringify({ snippet: `the end ${H}` })}\n${R} after`],
    ];
    const edge = `${"w ".repeat(4090)}${JSON.stringify({ t: `see ${H}`, s: `${R} more` })}`;
    const whole = (title) => JSON.stringify({ items: [{ title, snippet: `${R} more` }] });
    // 1,000 objects, each value of 3 to 8 characters, with `note` in the 501st; and the entry points that read all of it
    // (a row's head and learning's print stop short).
    const many = (note) => JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ name: `item${i}`, kind: ["red", "blue", "green", "amber"][i % 4], tag: `t${(i * 7919).toString(36).padStart(3, "0")}`, ...(i === 500 ? { note } : {}) })));
    const three = (text) => ({ redactedCall: text, redactedAnswer: text, runFile: text });
    return [
      ...split.map(([what, text]) => ({ name: `a held value split across ${what} withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all("[redacted]") })),
      // The first piece of an answer ends inside the first string: the second piece alone reads its quotes the wrong way
      // round, and the pass over what the pieces show reads them joined. A row's head never reaches the JSON.
      { name: "a held value split across two strings at the edge of an answer's first piece withholds the text", text: edge, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all("[redacted]", ["redacted"]) },
      { name: "a held value whole in one string of a JSON text is cut in place, and the JSON still parses (control)", text: whole(`see ${P24.join("")}`), values: [P24.join("")], hides: [H], exact: all(whole("see [redacted]")) },
      // The join view reads 6,000 short strings joined (names and values, about 50 KB), past several pieces of an answer:
      // no run of them is a held value, so only the held value itself is cut, in place, and every other string shows as
      // it came (control).
      { name: "1,000 objects of short values beside a held value: only the held value is cut (control)", text: many(P24.join("")), values: [P24.join("")], hides: [H], exact: three(many("[redacted]")) },
      { name: "1,000 objects of short values, a held value in none: shown as they came (control)", text: many("plain note"), values: [P24.join("")], hides: [], exact: three(many("plain note")) },
    ];
  })(),
  // Two encodings mixed (P2-A): each view decoded one family, so a split by an encoded space in one family and an
  // escaped one in the other, or a head in one and a tail in the other, read whole in none. The decoders stack in one
  // view, so each withholds the text.
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const u = (text) => [...text].map((char) => `${B}u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const pct = (text) => [...text].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    return [
      ["a percent-encoded space and an escaped one (%20\\u0020)", `x ${H}%20${B}u0020${R} y`],
      ["a plus and an escaped space (+\\u0020)", `x ${H}+${B}u0020${R} y`],
      ["its head written as \\u escapes, its rest percent-encoded", `x ${u(H)}${pct(R)} y`],
    ].map(([what, text]) => ({ name: `two encodings: a held value split by ${what} withholds the text`, text, values: [P24.join("")], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  // The #3626 review's texts with no false positive, each kept so: a held value cut in place next to "é" and "—", as they
  // are and as JSON's escapes; a Windows path with "\users" and then a "\u" escape (digits 1234) in it, with and without
  // a held value; a held value that itself holds a literal "\u" escape (digits 0041), as it is and JSON-escaped. Each is
  // cut in place, or shown as it came.
  ...(() => {
    const B = String.fromCharCode(92);
    const KEY = P24.join("");
    const literal = `${P24[0]}${B}u0041${P24[1]}`;
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const path = `dir C:${B}users${B}u1234${B}notes.txt`;
    return [
      ["a held value next to é and —", `see ${KEY}é— ok`, [KEY], "see [redacted]é— ok"],
      ["a held value next to escaped é and —", `{"note":"${KEY}${B}u00e9 ${B}u2014 end"}`, [KEY], `{"note":"[redacted]${B}u00e9 ${B}u2014 end"}`],
      ["a Windows path with \\users\\u1234 in it", path, [KEY], path],
      ["a held value in a Windows path with \\users\\u1234 in it", `dir C:${B}users${B}u1234${B}${KEY}.txt`, [KEY], `dir C:${B}users${B}u1234${B}[redacted].txt`],
      ["a held value holding a literal \\u0041", `see ${literal} ok`, [literal], "see [redacted] ok"],
      ["a held value holding a literal \\u0041, JSON-escaped", JSON.stringify({ v: literal }), [literal], `{"v":"[redacted]"}`],
    ].map(([what, text, values, shown]) => ({ name: `no false positive: ${what} is cut in place or shown as it came (control)`, text, values, hides: [P24[0]], exact: all(shown) }));
  })(),
  // Never less than the views of one family each: a view that decodes percent-encoding alone, or JSON's escapes alone
  // with an escaped quote read as a quote, reads a held value that has a family's text of its own (a literal "\n", a
  // literal "%41", a quote) as itself. The stacked views decode that text too, so each of these withheld at the base and
  // must still: a held value holding a literal "\n", split by a percent-encoded space; one holding a literal "%41" and a
  // "/", written by a JSON writer that escapes "/" (PHP's); one holding "é" and a quote, written by one that escapes
  // every non-ASCII character (Python's).
  ...(() => {
    const [H, R] = P24;
    const B = String.fromCharCode(92);
    const all = Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, "[redacted]"]));
    return [
      ["holding a literal \\n, split by a percent-encoded space", `${H}${B}n${R}`, `x ${H.slice(0, 8)}%20${H.slice(8)}${B}n${R} y`],
      ["holding a literal %41 and a /, its / escaped as \\/", `${H}%41/${R}`, `{"k":"${H}%41${B}/${R}"}`],
      ["holding é and a quote, written with é as a \\u escape", `${H}é"${R}`, `{"k": "${H}${B}u00e9${B}"${R}"}`],
    ].map(([what, value, text]) => ({ name: `one family's view: a held value ${what} withholds the text`, text, values: [value], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all }));
  })(),
  // A held value that holds a "," or a ":", split there by JSON: a login written as a name and its value, two halves
  // written as an array's two strings. The join view drops the punctuation between strings, so it reads the held value
  // without it; a needle of the held value with its "," and ":" gone, read only in the join view, withholds each. A short
  // object beside it whose join is no such needle shows as it came, and the held value whole in one string, or in prose
  // beside a quote, is cut in place (controls).
  ...(() => {
    const [H, R] = P24;
    const LOGIN = login("alice", "s3cretpass");
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    return [
      { name: "a held value's own : split as a JSON name and its value withholds the text", text: JSON.stringify({ alice: "s3cretpass" }), values: [LOGIN], hides: ["s3cretpass"], exact: all("[redacted]") },
      { name: "a held value's own , split as two strings of a JSON array withholds the text", text: JSON.stringify([H, R]), values: [`${H},${R}`], hides: [H.slice(0, 8), R.slice(0, 8)], exact: all("[redacted]") },
      { name: "a short object beside a held value with a : whose join is not that value shows as it came (control)", text: JSON.stringify({ alice: "bob" }), values: [LOGIN], hides: [], exact: all(JSON.stringify({ alice: "bob" })) },
      { name: "a held value with a : whole in one JSON string is cut in place (control)", text: JSON.stringify({ note: LOGIN }), values: [LOGIN], hides: ["s3cretpass"], exact: all(JSON.stringify({ note: "[redacted]" })) },
      { name: "a held value with a : whole in prose beside a quote is cut in place (control)", text: `say "hi" ${LOGIN} ok`, values: [LOGIN], hides: ["s3cretpass"], exact: all('say "hi" [redacted] ok') },
    ];
  })(),
  // A combining mark (P2-B): NFKC composes a letter and the mark after it into one character, so a held value with a
  // mark after its first or last letter, written as it is, escaped or percent-encoded, lost that letter. The squeeze
  // decomposes and drops every combining mark, on the held value's side and the text's, so each withholds the text. A
  // precomposed letter (Ź) decomposes the same. A held value with an accent in it, written as it is, is cut in place
  // (control).
  ...(() => {
    const KEY = P24.join("");
    const B = String.fromCharCode(92);
    const MARK = String.fromCharCode(0x301);
    const rest = KEY.slice(1);
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const accented = `${P24[0]}${String.fromCharCode(0xe9)}${P24[1]}`;
    return [
      ...[
        ["its first letter escaped and an escaped mark after its last", `x ${B}u005a${rest}${B}u0301 y`],
        ["an escaped mark after its first letter", `x Z${B}u0301${rest} y`],
        ["its first letter and a mark after its last percent-encoded", `x %5A${rest}%CC%81 y`],
        ["a mark after its first letter, as it is", `x Z${MARK}${rest} y`],
        ["its first letter precomposed with a mark", `x ${String.fromCharCode(0x179)}${rest} y`],
      ].map(([what, text]) => ({ name: `combining mark: a held value with ${what} withholds the text`, text, values: [KEY], hides: [rest.slice(0, 8), KEY.slice(17, 25)], exact: all("[redacted]") })),
      { name: "combining mark: a held value with an accent in it, as it is, is cut in place (control)", text: `see ${accented} ok`, values: [accented], hides: [P24[0], P24[1]], exact: all("see [redacted] ok") },
    ];
  })(),
  // HTML's numeric character references (P3): a held value written as "&#NNN;" or "&#xHH;", every character or some, or
  // split by one that stands for a space, read as itself in no view. The views decode them, so each withholds the text.
  // A reference that stands for no character (zero, a surrogate, past U+10FFFF) is text, and a held value cut in place
  // next to a reference stays cut in place (controls).
  ...(() => {
    const [H, R] = P24;
    const KEY = P24.join("");
    const dec = (text) => [...text].map((char) => `&#${char.codePointAt(0)};`).join("");
    const hex = (text, upper = false) => [...text].map((char) => `&#${upper ? "X" : "x"}${char.codePointAt(0).toString(16)[upper ? "toUpperCase" : "toLowerCase"]()};`).join("");
    const all = (shown) => Object.fromEntries(Object.keys(ENTRIES).map((name) => [name, shown]));
    const none = "a &#0; b &#xD800; c &#1114112; d &#x110000; e &#; f &#x; g &#65 h";
    return [
      ...[
        ["written as decimal references", `x ${dec(KEY)} y`],
        ["written as hex references, in lower and upper case", `x ${hex(H)}${hex(R, true)} y`],
        ["split by a reference to a space", `x ${H}&#32;${R} y`],
        ["one character of it a reference", `x ${H}${hex(R.slice(0, 1))}${R.slice(1)} y`],
      ].map(([what, text]) => ({ name: `character reference: a held value ${what} withholds the text`, text, values: [KEY], hides: [H.slice(0, 8), R.slice(4, 12)], exact: all("[redacted]") })),
      { name: "character reference: references that stand for no character are text (control)", text: none, values: [KEY], hides: [], exact: all(none) },
      { name: "character reference: a held value next to a reference is cut in place (control)", text: `see ${KEY}&#233;&#x2014; ok`, values: [KEY], hides: [H], exact: all("see [redacted]&#233;&#x2014; ok") },
    ];
  })(),
  // Adversarial texts of the cut read's cap: each is read once, so each comes back as its shape says.
  { name: "adversarial: eyJ x n, no dot", text: fill("eyJ"), values: [CUT_KEY], hides: [], exact: { runFile: fill("eyJ") } },
  { name: "adversarial: eyJ- x n, no dot", text: fill("eyJ-"), values: [CUT_KEY], hides: [], exact: { runFile: fill("eyJ-") } },
  { name: "adversarial: a private key header then a long run", text: `-----BEGIN ${fill("A", SIZE - 11)}`, values: [CUT_KEY], hides: [], exact: { runFile: `-----BEGIN ${fill("A", SIZE - 11)}` } },
  { name: "adversarial: ://a: then a long run", text: `://a:${fill("a", SIZE - 5)}`, values: [CUT_KEY], hides: [], exact: { runFile: `://a:${fill("a", SIZE - 5)}` } },
  (() => {
    const pointer = `ctx/${"a".repeat(32)}`;
    return { name: "adversarial: a repeated hex digit against a folded needle", text: `x ${fill("A", SIZE - 4)} y`, values: [pointer], hides: ["AAAAAAAA"], exact: { runFile: "x [redacted] y" } };
  })(),
  (() => {
    const values = Array.from({ length: 100 }, (_, i) => `held-${String(i).padStart(3, "0")}-${"k".repeat(20)}`);
    const text = fill(`words between ${values[7]} and more words `);
    return { name: "adversarial: 100 held values against 256 KiB", text, values, hides: [values[7]] };
  })(),
];

const short = (text) => (text.length > 60 ? `${JSON.stringify(text.slice(0, 40))}…(${text.length})` : JSON.stringify(text));

for (const c of CASES) {
  test(`contract: ${c.name}`, { timeout: 120_000 }, (t) => {
    const outs = {};
    for (const name of c.entries ?? Object.keys(ENTRIES)) outs[name] = ENTRIES[name](c.text, c.values);
    // Where the entry points disagree: each distinct answer and the entry points that give it.
    const groups = new Map();
    for (const [name, out] of Object.entries(outs)) groups.set(out, [...(groups.get(out) ?? []), name]);
    t.diagnostic(groups.size === 1 ? "all entry points agree" : [...groups].map(([out, names]) => `${names.join(",")}: ${short(out)}`).join(" | "));
    const problems = [];
    for (const [name, out] of Object.entries(outs)) {
      for (const hidden of c.hides) if (out.includes(hidden)) problems.push(`${name} shows ${JSON.stringify(hidden)}: ${short(out.slice(Math.max(0, out.indexOf(hidden) - 30)))}`);
      if (c.exact?.[name] !== undefined && out !== c.exact[name]) problems.push(`${name} answers ${short(out)}, not ${short(c.exact[name])}`);
      if (c.check?.[name] && !c.check[name](out)) problems.push(`${name} answers ${short(out)}`);
    }
    assert.deepEqual(problems, []);
  });
}

test("valueLeft: a held value only a view finds, wholly inside a cut in place, is not left; split by a cut's edge, it is", async () => {
  // New with valueLeft (learn/secrets.ts): imported where it is read, so the cases above still run on a build without it.
  const { valueLeft } = await import("../dist/learn/secrets.js");
  const address = `https://h.example/feed/me%40h.example/${P24.join("")}/basic.ics`;
  assert.equal(valueLeft(`see ${address} ok`, [address, decodeURIComponent(address)]), false);
  assert.equal(valueLeft(`cb?token=${P24[0]}\n${P24[1]} ok`, [P24.join("")]), true);
  assert.equal(valueLeft(`cb?token=${P24.join("")} ok`, [P24.join("")]), false);
});

/** A held value of MIN_SECRET (8) characters in no secret's shape, for a text that holds it every few characters. */
const DENSE = ["q8Vx", "R2mT"].join("");
const BACKSLASH = String.fromCharCode(92);

/** A held value of two lines of 40 characters or more: three parts (each line, and both joined), each a needle. */
const TWO_LINES = [`made-up-first-line-${"q8VxR2mT".repeat(3)}`, `made-up-second-line-${"R2mTq8Vx".repeat(3)}`];
/** A held value whose longest form needs the most a run's tail read takes (8,192 characters). */
const LONG = `${CUT_KEY}-${"q8VxR2mT7kPz".repeat(120)}`;
/** A held key as one is held in practice: a 4096-bit RSA key's PKCS #8 PEM, made here (about 3,270 characters, 50 body
 *  lines of 64 and a short last one): 51 parts, each a form and a plain needle, beside its whole forms. */
const RSA_PEM = generateKeyPairSync("rsa", { modulusLength: 4096, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey.trim();

/** The adversarial texts of `size` characters, each with the held values it is read with, each text stressing a stage:
 *  - the shapes' prefixes and runs;
 *  - each view's decoders over a text of nothing but what they decode: percent-encoded bytes, ASCII and not, "+",
 *    JSON's escapes at one level and two (each kind, back to back), a second level that starts and fails, Python's
 *    escapes ("\'", "\x41") and a single-quoted dict opened and never closed, named and numeric references (a name
 *    never closed, zeros as long as the text, no ";"), non-ASCII
 *    stretches for NFKC, characters that render as nothing (zero-width spaces, soft hyphens, both between letters),
 *    control characters (as they stand, escaped, percent-encoded, as references);
 *  - the join view over JSON, well formed and malformed: strings never closed, nesting as deep as the text, strings of
 *    nothing but backslashes;
 *  - a held value found every 9 characters, each find cut in place, and one in every string of a JSON text; and every
 *    11, a character between each two finds that no cut covers, so each find is checked against its own covered stretch
 *    of the view;
 *  - a held value of two lines, its lines over and over: its parts found at every line, each cut in place;
 *  - a held 4096-bit RSA key, over and over, and its body's lines in reverse order (never the key whole, every line a
 *    part cut in place): its 51 parts searched in each view;
 *  - runs too long to read, each with a held value's head glued to its end: each run's tail read again, 8,192
 *    characters of it, for the held value. */
const adversarial = (size) => {
  const f = (unit) => fill(unit, size);
  const shapes = [
    f("eyJ"), f("eyJ-"), `-----BEGIN ${fill("A", size - 11)}`, `-----BEGIN ${fill("PRIVATE KEY ", size - 11)}`, `://a:${fill("a", size - 5)}`, f("://a:"),
    f("sk-"), f("github_pat_"), f("ghp_"), f("xoxb-"), f("whsec_"), f("Bearer "), `Bearer ${fill("a", size - 7)}`, f("?token="),
    `?token=${fill("a", size - 7)}`, f(`${"a".repeat(1021)}eyJ`), f("eyJaaaaaaaa."), `account ${fill("1 ", size - 8)}`, f("routing number "), f("sort code "),
    `IBAN GB00${fill("A ", size - 9)}`, f("AKIA"), f("AIza"), f("-----BEGIN "), f("a-sk-"), f("Bearer a-Bearer "),
    f("xapp-"), `eyJaaaaaaaa.${fill("eyJ", size - 12)}`, f(`${"a".repeat(1020)}eyJ `),
  ];
  const B = BACKSLASH;
  const views = [
    f("%41"), f("%e9"), f("a+"), f(`${B}n`), f(`${B}${B}n`), f(`${B}u0041`), f(`${B}${B}u0041`), f(`${B}${B}u004`),
    f(`${B}t${B}"${B}/${B}${B}${B}r${B}b${B}f`), f(`${B}${B}${B}"${B}${B}t${B}${B}${B}${B}`),
    f(String.fromCharCode(0xe9)), f(`a${String.fromCharCode(0x301)}`), f(ZWSP), f(SHY), f(`a${SHY}b${ZWSP}`),
    // The stacked decoders, each kind back to back and mixed; character references, whole and cut short; precomposed
    // letters and letters each with a combining mark, for the decomposing squeeze.
    f(`%41${B}u0041&#65;+`), f(`&#65;`), f(`&#x1F600;`), f(`&#`), f(`&#1234567`), f(String.fromCharCode(0x179)), f(`Z${String.fromCharCode(0x301, 0x327)}`),
    // The join view: strings, names and values, empty strings, a lone quote, escaped quotes, JSON written in a string,
    // a name with no value, and runs between JSON's punctuation.
    f('"a",'), f('{"k":"v"},'), f('"",'), f('"'), f(`${B}"`), `"${fill(`[${B}"a${B}",${B}"b${B}"],`, size - 1)}`, f('":'), f('"a"   '), f("a,"),
    // Malformed JSON: a string never closed (with words, and one run of the text's whole length), nesting as deep as
    // the text (arrays, objects, both, opened and closed), strings of nothing but backslashes (closed, never closed, a
    // lone one escaping the quote after it), and a text that builds every view at once.
    `{"k":"${fill("ab ", size - 6)}`, `"${fill("a", size - 1)}`, f("["), f('{"a":'), f('[{"a":['), `${fill("[", size / 2)}${fill("]", size / 2)}`,
    `"${fill(B, size - 2)}"`, `"${fill(B, size - 1)}`, f(`"${B}${B}${B}"`), f(`"${B}`), f(`"%41+${B}u0041&#65;",`),
    // The strings join's four views at once: a quote, percent, "+", an escaped quote and an escaped backslash.
    f(`"%41+${B}"${B}${B}n&#65;",`), f(`"a+${B}${B}",`),
    // The quoted joins (a single-quoted dict's, read once as JSON's escapes and once as Python's): a lone apostrophe, a
    // name and its value opened and never closed, an apostrophe escaped, and Python's escapes back to back.
    f("'"), f("'a': '"), f(`'${B}`), f(`'a${B}'b${B}x41${B}${B}',`), f(`${B}x4`),
    // Named and numeric references: whole, a name never closed, a zero, one with no ";", zeros as long as the text, and
    // "+" in a quoted JSON text with a reference.
    f("&amp;"), f("&ampx"), f("&#0"), f("&#65"), `&#${fill("0", size - 2)}`, f('"a&#65;+",'),
    // A single-quoted dict written in a JSON string (a call's arguments, read one level down): many strings each holding
    // one, one string holding a dict opened and never closed, and Python's escapes at both levels, back to back.
    f(`"{'a': 'b'}",`), `"{'a': '${fill("ab ", size - 9)}`, `"${fill(`${B}${B}x41${B}${B}'`, size - 1)}"`, f(`"'${B}${B}x4${B}${B}'",`),
    f(`'${B}${B}${B}${B}x41`),
    // Control characters the views drop, as they stand, between letters, escaped (JSON's, twice, Python's in a
    // single-quoted dict), percent-encoded, as character references, and inside JSON strings.
    f("\u0000"), f("a\u0001"), f("\u007f\u0085"), f(`${B}u0000`), f(`${B}${B}u001f`), f(`'a${B}x01`), f("%00%C2%85"), f("&#1;&#x7f;"), f('"a\u0000",'),
    // U+FFFF, which the views drop in the text and keep only as a join's separator: as it stands, between letters and
    // inside JSON strings, escaped, percent-encoded, as a reference.
    // Terminal sequences: CSIs back to back, opened and never closed, OSCs never ended, ESCs alone, backspaces.
    f("\u001b[0m"), f("a\u001b[1;31m"), f("\u001b["), f("\u001b[1;"), f("\u001b]0;t"), f("\u001b]0;t\u0007"), f("\u001b"), f("a\b"), f("\b"), f("\u009b1"), f("\u009d0;"), f(`${B}u001b[0m`), f("%1B[0m"), f("&#27;[0m"),
    // Characters that show as a box or a blank, as they stand, escaped (a lone surrogate too), and a pair whole.
    f("\ufffe"), f("a\ufff9"), f("\ufdd0\ue000"), f("\u2800"), f("\ud800"), f("a\udc00"), f(`${B}ud800`), f("\u{1F600}"),
    f("\uffff"), f("a\uffff"), f('"a\uffff",'), f(`${B}uffff`), f("%EF%BF%BF"), f("&#xffff;"),
  ];
  return [
    ...[...shapes, ...views].map((text) => ({ text, values: [CUT_KEY] })),
    { text: f(`${DENSE} `), values: [DENSE] },
    // A held value found in every string of a JSON text, each find cut in place: the join view moves each cut to where
    // its string stands in the join, its cursor passing each cut once a pass.
    { text: f(`"${DENSE}",`), values: [DENSE] },
    // Every view at once, each over the text at nearly its whole length: one closed JSON string holding each family (a
    // percent byte, "+", a reference, an escaped quote, Python's "\x41" and an apostrophe one level down) turns on all
    // sixteen, and the held value's strings after it decode to themselves in each. It heads each block of about 4 KiB, so
    // each answer piece holds it too.
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`"${DENSE}",`.repeat(370)}`), values: [DENSE] },
    // The same in a string never closed, and in one escaped quote after another (JSON written in a string).
    { text: `{"k":"${fill(`${DENSE} `, size - 6)}`, values: [DENSE] },
    { text: f(`${BACKSLASH}"${DENSE}${BACKSLASH}",`), values: [DENSE] },
    { text: f(`${DENSE} x `), values: [DENSE] },
    // A held value found every 9 characters with a control between each two finds: the views drop it, so they read the
    // finds glued together, each still cut in place.
    { text: f(`${DENSE}\u0000`), values: [DENSE] },
    { text: f(`${DENSE}\uffff`), values: [DENSE] },
    { text: f(`${DENSE}\ud800`), values: [DENSE] },
    { text: f(`${DENSE}\u001b[0m`), values: [DENSE] },
    { text: f(`${DENSE}Z\b`), values: [DENSE] },
    { text: f(`"${DENSE}\uffff",`), values: [DENSE] },
    { text: f(`${TWO_LINES.join("\n")}\n`), values: [TWO_LINES.join("\n")] },
    { text: f(`${RSA_PEM}\n`), values: [RSA_PEM] },
    { text: f(`${RSA_PEM.split("\n").slice(1, -1).reverse().join("\n")}\n`), values: [RSA_PEM] },
    { text: f(`${"z".repeat(9000)}${LONG.slice(0, 16)} `), values: [LONG] },
  ];
};

/** Each entry point that reads a text whole or in pieces, as the work count drives it: redactSecrets and redactLearned
 *  with no byte bound, an answer, a call's result and a row's head. */
const READERS = {
  redactSecrets: (text, values) => redactSecrets(text, values, Buffer.byteLength(text)),
  redactLearned: (text, values) => redactLearned(text, values, Buffer.byteLength(text)),
  redactedAnswer: ENTRIES.redactedAnswer,
  redactedCall: ENTRIES.redactedCall,
  redacted: ENTRIES.redacted,
};

// The work count reads every stage: a text no shape's prefix is in, read with forms and needles only, still counts.
test("the work count reads each stage: a form's search, a view and its decoders, the whole-text check", async () => {
  const { cutSpans, holds, scanned } = await import("../dist/redact/match.js");
  const none = { forms: [], hexes: [], folds: [], plain: [] };
  const count = (read) => {
    scanned.chars = 0;
    read();
    return scanned.chars;
  };
  const text = fill("abcdefg ", 64 * 1024);
  const escaped = fill(`abc${BACKSLASH}ndefg `, 64 * 1024);
  const problems = [];
  // A form searched for over the text it is not in passes the whole text.
  const forms = count(() => cutSpans(text, { ...none, forms: [DENSE] }, []));
  if (forms < text.length) problems.push(`a form's search: ${forms} for ${text.length}`);
  // The whole-text check builds the squeezed view (every character read) and searches it.
  const check = count(() => holds(text, { ...none, plain: [DENSE] }));
  if (check < 2 * text.length * (7 / 8)) problems.push(`the whole-text check: ${check} for ${text.length}`);
  // A text with JSON's escapes is read in the squeezed view and the JSON view: two views built, each searched.
  const json = count(() => holds(escaped, { ...none, plain: [DENSE] }, { cuts: [[0, 3]] }));
  if (json < 3 * escaped.length) problems.push(`the JSON view: ${json} for ${escaped.length}`);
  // Each find checked against the view's covered stretches visits some of them: F finds, each inside its own cut,
  // against F covered stretches, visit about log2(F) each; against one covered stretch, one each. The same text and
  // finds otherwise, so the two counts differ by those visits (and the cover's pass over F cuts, not one).
  const finds = 4096;
  const separate = `${DENSE} x `.repeat(finds);
  const each = Array.from({ length: finds }, (_, i) => [11 * i, 11 * i + DENSE.length]);
  const apart = count(() => holds(separate, { ...none, plain: [DENSE] }, { cuts: each }));
  const together = count(() => holds(separate, { ...none, plain: [DENSE] }, { cuts: [[0, separate.length]] }));
  if (apart - together < 6 * finds) problems.push(`the finds checked against ${finds} covered stretches: ${apart - together} more than against one`);
  assert.deepEqual(problems, []);
});

// The adversarial texts, read by the shape scanners in work linear in their length: the characters the scanners visit,
// counted by match.ts, are at most a fixed multiple of the text's length, through both shape sets. The multiple, 128,
// covers each of the shapes' 30-odd prefixes sought once over the text and once over its cut, and each scanner's own
// reads; a scanner that read a run again at each place in it would pass it many times over at this size. The texts are
// read with no held value, so nothing but the shapes, the finds merged and the cut is counted: the views and the
// needles' searches are not read at all (holds returns before any view).
const ADVERSARIAL = [
  // A console-made API key's prefix (match.ts AGENTRUN_API_KEY): repeated; heading a run of lower case alone, which is
  // no key, and a run of capitals, which is one; before a space; and before runs of lower case that a space ends, one
  // character short of a key's length and past it, neither of them a key.
  fill("ar_key_"), `ar_key_${fill("a", SIZE - 7)}`, `ar_key_${fill("A", SIZE - 7)}`, fill("ar_key_ "), fill(`ar_key_${"a".repeat(42)} `), fill(`ar_key_${"a".repeat(60)} `),
  fill("eyJ"), fill("eyJ-"), `-----BEGIN ${fill("A", SIZE - 11)}`, `-----BEGIN ${fill("PRIVATE KEY ", SIZE - 11)}`, `://a:${fill("a", SIZE - 5)}`, fill("://a:"),
  fill("sk-"), fill("github_pat_"), fill("ghp_"), fill("xoxb-"), fill("whsec_"), fill("Bearer "), `Bearer ${fill("a", SIZE - 7)}`, fill("?token="),
  `?token=${fill("a", SIZE - 7)}`, fill(`${"a".repeat(1021)}eyJ`), fill("eyJaaaaaaaa."), `account ${fill("1 ", SIZE - 8)}`, fill("routing number "), fill("sort code "),
  `IBAN GB00${fill("A ", SIZE - 9)}`, fill("AKIA"), fill("AIza"), fill("-----BEGIN "), fill("a-sk-"), fill("Bearer a-Bearer "),
  // From secrets-linear.test.mjs's timed list, which this count replaces: a Slack app token's prefix, a JWT's first part
  // then "eyJ" with no dot, and "eyJ" first in each run of 1,024 that a space ends.
  fill("xapp-"), `eyJaaaaaaaa.${fill("eyJ", SIZE - 12)}`, fill(`${"a".repeat(1020)}eyJ `),
];

test("adversarial texts: the characters the shape scanners visit are at most a fixed multiple of the text's length", async (t) => {
  const { scanned } = await import("../dist/redact/match.js");
  const over = [];
  let most = 0;
  for (const text of ADVERSARIAL) {
    for (const redact of [redactSecrets, redactLearned]) {
      scanned.chars = 0;
      redact(text, [], Buffer.byteLength(text));
      most = Math.max(most, scanned.chars / text.length);
      if (scanned.chars > 128 * text.length) over.push(`${redact.name} ${short(text)}: ${scanned.chars} for ${text.length}`);
    }
  }
  t.diagnostic(`the most characters visited per character of a text: ${most.toFixed(1)}`);
  assert.deepEqual(over, []);
});

// The whole pipeline reads a text in work linear in its length: every character a stage visits, counted by match.ts
// (the shapes' prefixes and runs, each form, hex and folded search, each view built, its decoders and its cover, each
// needle searched in it, the cut) and by key-refusal.ts (each piece's end found, each peek, the pass's join), is at most
// WORK per character of the text, at 128 KiB and at 512 KiB, through each reader, for one held value.
//
// WORK, from the code's structure, per character of the text, one held value (at most 7 forms and 7 plain needles: as
// written, and its base64 at three alignments in two alphabets; one hex; at most one folded):
// - the shapes, sought over the text and over its cut, and each run read: 128, the shapes' own bound (the test above);
// - planCut's finds: the text lowered (1), each form and the hex searched (2 each, a find and the text before it: 16),
//   the folded search (4), the finds merged (1): about 21;
// - one whole-text check: what the text holds that a view decodes (9); sixteen views at most: the squeezed one and the
//   percent-decoded two (one with "+") built in 9 reads each (its special characters found, its blanks, its non-ASCII
//   stretches squeezed twice, its cover), the views of JSON's escapes alone (two levels, and one where the text has an
//   escaped backslash) and the two stacked ones (one with "+") in 23 each (two levels of escapes read per character
//   decoded); the nested join, which reads the text as JSON first (3: at level 0, again at level 1 inside a string, and
//   the whitespace after a string), writes its join (2: each character in it at most twice, values then all, or names
//   then all), and two decoding views over that join (one with "+": 46 each, 92); the strings join, read at level 0
//   alone (2) and written (2), and four decoding views over it (one level of JSON's escapes alone, with percent, with
//   percent and "+", and two levels: 46 each, 184); the quoted join (a single-quoted dict's), read at level 0 (2) and
//   written (2), and the again join (each JSON string's text read one level down for a dict written in it), the text
//   read at level 0 for its strings and they at level 1 (3) and written (2), and the two written once more one after the
//   other (4); three decoding views over them (JSON's escapes over both: 92; Python's over the quoted join where the
//   text holds one, and both levels of them over the again join where it holds a quote: 46 each; 184); then each
//   searched for 7 plain needles, the hex and the fold, lowered and flattened, each find checked against the covered
//   stretches (21 each, 42 over a join, 84 over the two joins one after the other): about 1,082; planCut runs two (the
//   text with its cuts, then the cut text, at most 10/8 as long): about 2,435;
// - so planCut is about 2,584; an answer adds its pieces' ends and joins (10), heldIn's check of what it returns (10/8
//   of a check: 1,353), of the pieces as they came (1,082), and its shape pass (64): about 5,093.
// That sum takes each stage at its most at once, and its views are all reachable together: familiesOf reads each family
// as present or absent, so one closed JSON string holding each of them turns on all sixteen views, and the rest of the
// text decodes to itself at nearly its whole length in each (the text of DENSE's strings, each block of about 4 KiB
// headed by one such string). It is the most measured here: 963.0 per character at 128 KiB and 967.8 at 512 KiB,
// through redactedAnswer; every other text measures under 450 (a held RSA key's, made anew each run, moves by a few).
// A held value of two lines adds its three parts as forms and plain needles (about 30 more). A held value of k long
// lines adds k + 1 of each: its work grows with k, linear in the text all the same.
// WORK stays 1,024, the bound from before the stacked and join views. The most measured, and each text's most, are in
// the test's diagnostics; a text that passes 1,024 is a finding, not a reason to raise the bound. A stage that read again from the start at each find passes the text once per find:
// a held value found every 9 characters is found 14,563 times in 128 KiB, and one in every string of a JSON text (every
// 11 characters) 47,662 times in 512 KiB, which a join that passed the cuts from the first at each string reads about
// 2.3 billion times over.
const WORK = 1024;

test("adversarial texts: the characters the whole pipeline visits are at most WORK per character, at 128 KiB and 512 KiB", async (t) => {
  const { scanned } = await import("../dist/redact/match.js");
  const over = [];
  for (const size of [128 * 1024, 512 * 1024]) {
    let most = 0;
    let where = "";
    for (const { text, values } of adversarial(size)) {
      let its = 0;
      let by = "";
      for (const [name, read] of Object.entries(READERS)) {
        scanned.chars = 0;
        read(text, values);
        const per = scanned.chars / text.length;
        if (per > its) [its, by] = [per, name];
        if (per > most) [most, where] = [per, `${name} ${short(text)}`];
        if (scanned.chars > WORK * text.length) over.push(`${size}: ${name} ${short(text)}: ${scanned.chars} for ${text.length}`);
      }
      // Each text's most, so a change that moves one text shows up here.
      t.diagnostic(`${size / 1024} KiB: ${its.toFixed(1)} per character, ${by}, ${short(text)}`);
    }
    t.diagnostic(`${size / 1024} KiB: the most characters visited per character of a text: ${most.toFixed(1)}, ${where}`);
  }
  assert.deepEqual(over, []);
});

// Malformed JSON nested as deep as the text, past a call's stop: every name opens another object or array, so the text
// holds names and no value, and two of the views the read past the stop walks show none of a piece of it. That read
// gives up there and the call's result is withheld whole; before the read counted what each view shows, it showed the
// first CALL_RESULT_CHARS. Withheld, not shown: pinned as it is now, so a change either way is seen.
test("malformed JSON nested as deep as the text, past a call's stop, is withheld whole: '{\"a\":' and '[{\"a\":[' at 128 KiB and 512 KiB", () => {
  const shown = [];
  for (const unit of ['{"a":', '[{"a":[']) for (const size of [128 * 1024, 512 * 1024]) {
    const out = ENTRIES.redactedCall(fill(unit, size), [CUT_KEY]);
    if (out !== "[redacted]") shown.push(`${unit} at ${size}: ${out.length} characters`);
  }
  assert.deepEqual(shown, []);
});

// A text of very many shape finds, read whole (no byte bound, as learning's compile reads a previous answer): its finds
// are gathered one by one, never as one call's arguments, so it is cut and never throws for its count of finds.
test("a text of very many shape finds read whole is cut, never thrown on: \"AKIA\" x 131072, no byte bound", () => {
  const text = "AKIA".repeat(131072);
  const problems = [];
  for (const redact of [redactSecrets, redactLearned]) {
    let out;
    try {
      out = redact(text, [CUT_KEY], Number.POSITIVE_INFINITY);
    } catch (error) {
      problems.push(`${redact.name} threw ${error?.name}: ${String(error?.message).slice(0, 80)}`);
      continue;
    }
    if (/AKIA[0-9A-Z]{16}/.test(String(out))) problems.push(`${redact.name} shows a key shape`);
  }
  assert.deepEqual(problems, []);
});
