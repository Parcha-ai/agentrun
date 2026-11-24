// The contract every redactor of served text keeps, one table run through each entry point there is: a row's head
// (redacted), an answer (redactedAnswer), a call's result as a grader reads it (redactedCall, cut to CALL_RESULT_CHARS),
// learning's printer (redactSecrets at PRINT_MAX) and a file read with cut=run (redactSecrets over the whole text, as
// run-reads-over-store.ts cutRunFile calls it). Each case names what no entry point may show, and the exact text where
// an entry point's own contract fixes it. Where the entry points answer differently, the test's diagnostics say which
// differ, so a change that moves one of them shows up there. Every key-shaped text here is put together at run time.
import assert from "node:assert/strict";
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
  (() => {
    const { lines, pem } = fakePem(6);
    return {
      name: "a held PEM-like value whose armor is glued to the end of a run too long to read withholds the text",
      text: `${"Z".repeat(20_000)}${pem} end`,
      values: [pem],
      hides: lines.map((line) => line.slice(0, 12)),
      exact: { redactedAnswer: "[redacted]", redactedCall: "[redacted]" },
    };
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
      {
        name: "the first 11 lines of a held PEM-like value (head -n 11) show no line of it",
        text: `$ head -n 11 key.pem\n${pem.split("\n").slice(0, 11).join("\n")}\n`,
        values: [pem],
        hides: lines.slice(0, 10).map((line) => line.slice(0, 12)),
        exact: all(`$ head -n 11 key.pem\n${Array(11).fill("[redacted]").join("\n")}\n`),
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
  // A held value with line breaks written in JSON: escaped once ("\n"), it is cut in place where it stands; escaped
  // twice (JSON in a JSON string, "\\n"), or with its line breaks written "\r\n", it is found in the text decoded and
  // withholds the text.
  ...(() => {
    const { lines, pem } = fakePem(6);
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
        name: "a held PEM-like value in JSON in a JSON string, its line breaks escaped twice, withholds the text",
        text: JSON.stringify({ out: JSON.stringify({ private_key: pem }) }),
        values: [pem],
        hides: lines.map((line) => line.slice(0, 12)),
        exact: all("[redacted]"),
      },
      {
        name: "a held PEM-like value in JSON, its line breaks written as \\r\\n, withholds the text",
        text: JSON.stringify({ private_key: pem.replaceAll("\n", "\r\n") }),
        values: [pem],
        hides: lines.map((line) => line.slice(0, 12)),
        exact: all("[redacted]"),
      },
    ];
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

/** The adversarial texts of `size` characters, each with the held values it is read with: the shapes' prefixes and
 *  runs; each view's decoders over a text of nothing but what they decode (percent-encoded bytes, ASCII and not, "+",
 *  JSON's escapes at one level and two, a second level that starts and fails, non-ASCII stretches for NFKC, characters
 *  that render as nothing); and a held value found every 9 characters, each find cut in place. */
const adversarial = (size) => {
  const f = (unit) => fill(unit, size);
  const shapes = [
    f("eyJ"), f("eyJ-"), `-----BEGIN ${fill("A", size - 11)}`, `-----BEGIN ${fill("PRIVATE KEY ", size - 11)}`, `://a:${fill("a", size - 5)}`, f("://a:"),
    f("sk-"), f("github_pat_"), f("ghp_"), f("xoxb-"), f("whsec_"), f("Bearer "), `Bearer ${fill("a", size - 7)}`, f("?token="),
    `?token=${fill("a", size - 7)}`, f(`${"a".repeat(1021)}eyJ`), f("eyJaaaaaaaa."), `account ${fill("1 ", size - 8)}`, f("routing number "), f("sort code "),
    `IBAN GB00${fill("A ", size - 9)}`, f("AKIA"), f("AIza"), f("-----BEGIN "), f("a-sk-"), f("Bearer a-Bearer "),
  ];
  const B = BACKSLASH;
  const views = [
    f("%41"), f("%e9"), f("a+"), f(`${B}n`), f(`${B}${B}n`), f(`${B}u0041`), f(`${B}${B}u0041`), f(`${B}${B}u004`),
    f(String.fromCharCode(0xe9)), f(`a${String.fromCharCode(0x301)}`), f(ZWSP),
  ];
  return [...[...shapes, ...views].map((text) => ({ text, values: [CUT_KEY] })), { text: f(`${DENSE} `), values: [DENSE] }];
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
  assert.deepEqual(problems, []);
});

// The whole pipeline reads a text in work linear in its length: every character a stage visits, counted by match.ts
// (the shapes' prefixes and runs, each form, hex and folded search, each view built, its decoders and its cover, each
// needle searched in it, the cut) and by key-refusal.ts (each piece's end found, each peek, the pass's join), is at most
// WORK per character of the text, at 128 KiB and at 512 KiB, through each reader, for one held value.
//
// WORK, from the code's structure, per character of the text, one held value (at most 7 forms and 7 plain needles: as
// written, and its base64 at three alignments in two alphabets; one hex; at most one folded):
// - the shapes, sought over the text and over its cut, and each run read: 128, the shapes' own bound before;
// - planCut's finds: the text lowered (1), each form and the hex searched (2 each, a find and the text before it: 16),
//   the folded search (4), the finds merged (1): about 21;
// - one whole-text check: four views at most, each built in 9 reads (its special characters found, its blanks, its
//   non-ASCII stretches squeezed twice, its cover) and the JSON view in 23 (two levels of escapes read per character
//   decoded), then each searched for 7 plain needles, the hex and the fold, lowered and flattened (21 each): about 134;
//   planCut runs two (the text with its cuts, then the cut text, at most 10/8 as long): about 302;
// - so planCut is about 452; an answer adds its pieces' ends and joins (6), heldIn's check of what it returns (10/8 of a
//   check: 168), of the pieces as they came (134), and its shape pass (64): about 824.
// 1024 is that, rounded up to a power of two. A stage that read again from the start at each find passes the text once
// per find: a held value found every 9 characters is found 14,563 times in 128 KiB.
const WORK = 1024;

test("adversarial texts: the characters the whole pipeline visits are at most WORK per character, at 128 KiB and 512 KiB", { timeout: 900_000 }, async (t) => {
  const { scanned } = await import("../dist/redact/match.js");
  const over = [];
  for (const size of [128 * 1024, 512 * 1024]) {
    let most = 0;
    let where = "";
    for (const { text, values } of adversarial(size)) {
      for (const [name, read] of Object.entries(READERS)) {
        scanned.chars = 0;
        read(text, values);
        const per = scanned.chars / text.length;
        if (per > most) [most, where] = [per, `${name} ${short(text)}`];
        if (scanned.chars > WORK * text.length) over.push(`${size}: ${name} ${short(text)}: ${scanned.chars} for ${text.length}`);
      }
    }
    t.diagnostic(`${size / 1024} KiB: the most characters visited per character of a text: ${most.toFixed(1)}, ${where}`);
  }
  assert.deepEqual(over, []);
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
