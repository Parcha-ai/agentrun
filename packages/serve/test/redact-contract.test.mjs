// The contract every redactor of served text keeps, one table run through each entry point there is: a row's head
// (redacted), an answer (redactedAnswer), a call's result as a grader reads it (redactedCall, cut to CALL_RESULT_CHARS),
// learning's printer (redactSecrets at PRINT_MAX) and a file read with cut=run (redactSecrets over the whole text, as
// run-reads-over-store.ts cutRunFile calls it). Each case names what no entry point may show, and the exact text where
// an entry point's own contract fixes it. Where the entry points answer differently, the test's diagnostics say which
// differ, so a change that moves one of them shows up there. Every key-shaped text here is put together at run time.
import assert from "node:assert/strict";
import { test } from "node:test";
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

/** Each case: the text, the held values, what no entry point shows (`hides`), and where an entry point's contract fixes
 *  its answer, that answer (`exact`). `entries` narrows a case to the entry points whose contract it is. */
const CASES = [
  {
    name: "P2-4: a held value whose first half is a credential parameter's value and whose second half is past a line break",
    text: `cb?token=${P24[0]}\n${P24[1]} ok`,
    values: [P24.join("")],
    hides: [P24[0].slice(0, 8), P24[1].slice(0, 8)],
  },
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

// The adversarial texts, read by the shape scanners in work linear in their length: the characters the scanners visit,
// counted by match.ts, are at most a fixed multiple of the text's length, through both shape sets.
const ADVERSARIAL = [
  fill("eyJ"), fill("eyJ-"), `-----BEGIN ${fill("A", SIZE - 11)}`, `-----BEGIN ${fill("PRIVATE KEY ", SIZE - 11)}`, `://a:${fill("a", SIZE - 5)}`, fill("://a:"),
  fill("sk-"), fill("github_pat_"), fill("ghp_"), fill("xoxb-"), fill("whsec_"), fill("Bearer "), `Bearer ${fill("a", SIZE - 7)}`, fill("?token="),
  `?token=${fill("a", SIZE - 7)}`, fill(`${"a".repeat(1021)}eyJ`), fill("eyJaaaaaaaa."), `account ${fill("1 ", SIZE - 8)}`, fill("routing number "), fill("sort code "),
  `IBAN GB00${fill("A ", SIZE - 9)}`, fill("AKIA"), fill("AIza"), fill("-----BEGIN "), fill("a-sk-"), fill("Bearer a-Bearer "),
];

test("adversarial texts: the characters the shape scanners visit are at most a fixed multiple of the text's length", async () => {
  const { scanned } = await import("../dist/redact/match.js");
  const over = [];
  for (const text of ADVERSARIAL) {
    for (const redact of [redactSecrets, redactLearned]) {
      scanned.chars = 0;
      redact(text, [CUT_KEY], Buffer.byteLength(text));
      if (scanned.chars > 64 * text.length) over.push(`${redact.name} ${short(text)}: ${scanned.chars} for ${text.length}`);
    }
  }
  assert.deepEqual(over, []);
});
