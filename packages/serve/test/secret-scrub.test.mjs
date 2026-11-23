// Scrubber beta 1 (secret-cut.ts scrub, secret-rules.ts SCRUB_RULES): one pass over a text that cuts, by anchored rules
// only, known formats, values the server holds, whole dumps (env output, .env files, ~/.ssh), values beside a label and
// personal details. Every cut names its rule, its kind and whether a preview may restore it (fixed per kind), and its
// shape (prefix class and length), never its value. Count mode returns counts and cuts, never text; cut mode fails closed.
// Every fixture here is synthetic and built at run time: no real key, path, address or session text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCRUB_RULES, scrub, scrubWith } from "../dist/secret-cut.js";

/** Restorable, by kind: the contract's fixed map. */
const RESTORABLE = { format: false, held: false, dump: false, label: true, personal: true, jev: true };

// Synthetic secrets, built so no scanner reads a literal in this file as a key.
const SK = `sk-${"Zq7Wm2".repeat(8)}`;
const GHP = `ghp_${"A1b2C3".repeat(6)}`;
const AKIA = `AKIA${"Q7X2".repeat(4)}`;
const JWT = `eyJ${"hbGciOiJIUzI1"}.eyJ${"zdWIiOiIxMjM0"}.${"c2lnbmF0dXJl".repeat(2)}`;
const NPM = `npm_${"k3Jd9Q".repeat(6)}`;
const PEM = [`-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "QyNTUxOQAAACBzeW50aGV0aWMtdGVzdC1rZXktbm90LXJlYWwtYXQtYWxsAAAAAAAAAA==", `-----END ${"OPENSSH"} PRIVATE KEY-----`].join("\n");
const HELD = `planted-${"h3ld".repeat(5)}`;
const BLOB = `AAAAC3NzaC1lZDI1NTE5AAAAI${"Fq9TzYw2Lk8".repeat(6)}`;

const cutOf = async (text, held) => {
  const out = await scrub(text, { mode: "cut", held });
  assert.equal(out.ok, true, `scrub failed closed on ${JSON.stringify(text.slice(0, 80))}`);
  return out;
};
/** The one cut of `text`, asserting there is exactly one. */
const oneCut = async (text, held) => {
  const out = await cutOf(text, held);
  assert.equal(out.cuts.length, 1, `cuts: ${JSON.stringify(out.cuts)} of ${JSON.stringify(text)}`);
  return { ...out, cut: out.cuts[0] };
};
const kept = async (text, held) => {
  const out = await cutOf(text, held);
  assert.deepEqual(out.cuts, [], `expected no cut of ${JSON.stringify(text)}`);
  assert.equal(out.text, text);
};

test("SCRUB_RULES: unique ids, a known kind each, restorable fixed by kind", () => {
  const ids = SCRUB_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of SCRUB_RULES) {
    assert.ok(rule.kind in RESTORABLE, `${rule.id}: kind ${rule.kind}`);
    assert.equal(rule.restorable, RESTORABLE[rule.kind], `${rule.id} restorable`);
  }
  for (const id of ["sk-key", "github-token", "aws-access-key", "jwt", "private-key-block", "bearer-token", "url-password", "url-credential", "secretlint", "held-value", "env-dump", "env-file", "ssh-file", "secret-assign", "sshpass", "mysql-password", "password-flag", "auth-header", "curl-user", "home-path", "email", "private-ip"]) {
    assert.ok(ids.includes(id), `rule ${id}`);
  }
});

test("format: a known key is cut whole, not restorable, its shape a public prefix and a length", async () => {
  for (const [secret, rule, prefix] of [[SK, "sk-key", "sk-"], [GHP, "github-token", "ghp_"], [AKIA, "aws-access-key", "AKIA"], [JWT, "jwt", "eyJ"]]) {
    const { text, cut } = await oneCut(`the tool printed ${secret} and went on`);
    assert.equal(text, `the tool printed [redacted:${rule}] and went on`);
    assert.equal(cut.rule, rule);
    assert.equal(cut.kind, "format");
    assert.equal(cut.restorable, false);
    assert.equal(cut.shape, `${prefix}…[${secret.length}]`);
    assert.equal(cut.end - cut.start, secret.length);
  }
});

test("format: a private key's PEM block is one cut, BEGIN to END", async () => {
  const { text, cut } = await oneCut(`key:\n${PEM}\ndone`);
  assert.equal(text, "key:\n[redacted:private-key-block]\ndone");
  assert.equal(cut.kind, "format");
});

test("format: secretlint's hits are cut too (a token SHAPES has no shape for)", async () => {
  const { text, cut } = await oneCut(`//registry.npmjs.org/:_authToken=${NPM}\n`);
  assert.ok(!text.includes(NPM), text);
  assert.equal(cut.kind, "format");
  assert.equal(cut.restorable, false);
});

test("held: a held value in every form the redactors know is cut, not restorable", async () => {
  const forms = [HELD, JSON.stringify(`a"${HELD}`).slice(1, -1), Buffer.from(HELD).toString("base64"), Buffer.from(HELD).toString("hex"), encodeURIComponent(`${HELD}/x y`)];
  for (const form of forms) {
    const out = await cutOf(`seen: ${form} end`, [HELD]);
    assert.ok(out.cuts.length >= 1, form);
    assert.ok(out.cuts.every((cut) => cut.rule === "held-value" && cut.kind === "held" && cut.restorable === false), JSON.stringify(out.cuts));
    assert.ok(!out.text.includes(HELD), out.text);
  }
});

test("held: a value shorter than 8 characters is not held (it would match text by chance)", async () => {
  await kept("the word abc appears", ["abc"]);
});

test("held: a value left in the text in a form the pass cannot cut in place fails closed", async () => {
  const split = `${HELD.slice(0, 10)}\n${HELD.slice(10)}`;
  const out = await scrub(`printed ${split}`, { mode: "cut", held: [HELD] });
  assert.deepEqual(out, { ok: false, counts: {} });
});

test("label: a password typed beside its label is cut, the label kept, restorable", async () => {
  const cases = [
    ["PGPASSWORD=s3cretPgPw psql -h db", "PGPASSWORD=[redacted:secret-assign] psql -h db", "secret-assign"],
    ["MYSQL_PWD='my sql pw' mysql", "MYSQL_PWD='[redacted:secret-assign]' mysql", "secret-assign"],
    ["export DB_PASSWORD=\"hunter2hunter\"", "export DB_PASSWORD=\"[redacted:secret-assign]\"", "secret-assign"],
    ["sshpass -p 'Pa55word!' ssh box", "sshpass -p '[redacted:sshpass]' ssh box", "sshpass"],
    ["sshpass -pPa55word ssh box", "sshpass -p[redacted:sshpass] ssh box", "sshpass"],
    ["mysql -uroot -pR00tPass shop", "mysql -uroot -p[redacted:mysql-password] shop", "mysql-password"],
    ["mysqldump -u root -p R00tPass shop > dump.sql", "mysqldump -u root -p [redacted:mysql-password] shop > dump.sql", "mysql-password"],
    ["psql --password=pgFlagPw1 -h db", "psql --password=[redacted:password-flag] -h db", "password-flag"],
    ["tool login --password pgFlagPw2", "tool login --password [redacted:password-flag]", "password-flag"],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA==' https://api.example.com", "curl -H 'Authorization: Basic [redacted:auth-header]' https://api.example.com", "auth-header"],
    ["curl -H \"X-Api-Key: plainKeyValue123\" https://api.example.com", "curl -H \"X-Api-Key: [redacted:auth-header]\" https://api.example.com", "auth-header"],
    ["curl -u admin:adminPw99 https://api.example.com", "curl -u admin:[redacted:curl-user] https://api.example.com", "curl-user"],
  ];
  for (const [input, expected, rule] of cases) {
    const { text, cut } = await oneCut(input);
    assert.equal(text, expected);
    assert.equal(cut.rule, rule);
    assert.equal(cut.kind, "label");
    assert.equal(cut.restorable, true);
  }
});

test("label: -p outside a mysql command and lowercase unquoted names are no password", async () => {
  await kept("mkdir -p build/out && ssh -p 2222 host");
  await kept("client = make_client(api_key=api_key, token=tok)");
});

test("label: placeholders are never cut", async () => {
  for (const text of [
    "PGPASSWORD=$PGPASS psql",
    "DB_PASSWORD=${DB_PASSWORD} ./run",
    "API_KEY=<token> ./run",
    "API_KEY=*** ./run",
    "API_KEY=YOUR_API_KEY ./run",
    "API_KEY=xxx ./run",
    "curl -H 'Authorization: Bearer $TOKEN' https://api.example.com",
    "curl -u admin:$ADMIN_PASS https://api.example.com",
    "sshpass -p \"$SSHPASS\" ssh box",
    "tool --password=<password>",
  ]) await kept(text);
});

test("overlap: a known format beside a label wins (not restorable beats restorable on one span)", async () => {
  const token = `tok${"9Lm3".repeat(6)}`;
  const { text, cut } = await oneCut(`curl -H "Authorization: Bearer ${token}" https://api.example.com`);
  assert.equal(text, `curl -H "Authorization: Bearer [redacted:bearer-token]" https://api.example.com`);
  assert.equal(cut.restorable, false);
  assert.equal(cut.kind, "format");
});

test("overlap: a held value inside a label's value makes the whole cut not restorable", async () => {
  const { text, cut } = await oneCut(`PGPASSWORD=pre${HELD} psql`, [HELD]);
  assert.equal(text, "PGPASSWORD=[redacted:held-value] psql");
  assert.equal(cut.kind, "held");
  assert.equal(cut.restorable, false);
});

test("dump: env output after its command is dropped whole as one cut, the command kept", async () => {
  const text = ["$ env", "PATH=/usr/bin:/bin", "SHELL=/bin/bash", "LANG=C.UTF-8", `SOME_TOKEN=${HELD}x`, "$ echo done"].join("\n");
  const { text: out, cut } = await oneCut(text);
  assert.equal(out, ["$ env", "[redacted:env-dump 4 lines]", "$ echo done"].join("\n"));
  assert.equal(cut.kind, "dump");
  assert.equal(cut.restorable, false);
});

test("dump: an env block with no command is found by its shape (two of PATH, HOME, SHELL, USER...)", async () => {
  const text = ["HOME=/root", "PATH=/usr/bin", "HOSTNAME=box1", "TERM=xterm"].join("\n");
  const { text: out } = await oneCut(text);
  assert.equal(out, "[redacted:env-dump 4 lines]");
});

test("dump: export -p output (declare -x lines) is one dump", async () => {
  const text = ['declare -x COLOR="blue"', 'declare -x SIZE="9"', 'declare -x MODE="fast"'].join("\n");
  assert.equal((await oneCut(text)).text, "[redacted:env-dump 3 lines]");
});

test("dump: three plain assignments with no command and no env names are not a dump", async () => {
  await kept(["COLOR=blue", "SIZE=9", "MODE=fast"].join("\n"));
});

test("dump: a .env file read is dropped whole; a .env.example is not", async () => {
  const body = ["# app", "DATABASE_URL=postgres://db/app", "", "FEATURE_X=on"];
  const { text, cut } = await oneCut(["$ cat .env.local", ...body, "$ ls"].join("\n"));
  assert.equal(text, ["$ cat .env.local", "[redacted:env-file 4 lines]", "$ ls"].join("\n"));
  assert.equal(cut.rule, "env-file");
  await kept(["$ cat .env.example", "# app", "FEATURE_X=on"].join("\n"));
});

test("dump: a text given as a .env file's content (opts.path) is one dump", async () => {
  const out = await scrub("A=1\nB=2", { mode: "cut", path: "/srv/app/.env.production" });
  assert.equal(out.ok && out.text, "[redacted:env-file 2 lines]");
});

test("dump: ~/.ssh contents are dropped: a config read, and key lines with a whole key", async () => {
  const config = ["$ cat ~/.ssh/config", "Host build", "  HostName build.internal", "  User deploy", "  IdentityFile ~/.ssh/id_build", "$ pwd"].join("\n");
  assert.equal((await oneCut(config)).text, ["$ cat ~/.ssh/config", "[redacted:ssh-file 4 lines]", "$ pwd"].join("\n"));
  const keys = [`ssh-ed25519 ${BLOB} one@box`, `ssh-ed25519 ${BLOB}Q two@box`].join("\n");
  const { text, cut } = await oneCut(`authorized:\n${keys}`);
  assert.equal(text, "authorized:\n[redacted:ssh-file 2 lines]");
  assert.equal(cut.kind, "dump");
});

test("personal: a home path keeps its structure; the user segment is cut, restorable", async () => {
  for (const [input, expected] of [
    ["open /home/alicea/proj/x.ts", "open /home/[redacted:home-path]/proj/x.ts"],
    ["at /Users/bobb/Library/a", "at /Users/[redacted:home-path]/Library/a"],
    ["C:\\Users\\carolc\\Desktop", "C:\\Users\\[redacted:home-path]\\Desktop"],
    ["cd /home/daved", "cd /home/[redacted:home-path]"],
  ]) {
    const { text, cut } = await oneCut(input);
    assert.equal(text, expected);
    assert.equal(cut.kind, "personal");
    assert.equal(cut.restorable, true);
  }
  await kept("cd /home/$USER/x and /home/<user>/y and /Users/Shared/z");
});

test("personal: an email is cut; SSH remotes, noreply trailers, image names and example domains are not", async () => {
  const { text, cut } = await oneCut("mail erin.e@corp-mail.io today");
  assert.equal(text, "mail [redacted:email] today");
  assert.equal(cut.rule, "email");
  assert.equal(cut.restorable, true);
  await kept("git clone git@github.com:org/repo.git");
  await kept("Co-Authored-By: Bot <noreply@anthropic.com>\nCo-Authored-By: x <123+x@users.noreply.github.com>");
  await kept("![logo](assets/logo@2x.png) and a@b.example.com and pkg react@18.3.1");
});

test("personal: private addresses are cut; loopback, unspecified, public, versions and ranges are not", async () => {
  for (const ip of ["10.1.2.3", "172.20.0.5", "192.168.1.20", "100.100.5.6", "fd12:3456::1", "fe80::1"]) {
    const { text, cut } = await oneCut(`host ${ip} up`);
    assert.equal(text, "host [redacted:private-ip] up");
    assert.equal(cut.kind, "personal");
  }
  await kept("127.0.0.1 and 0.0.0.0 and 8.8.8.8 and 172.32.0.1 and 100.128.0.1");
  await kept("node v10.2.3.4 and version 10.2.3.4 and the range 10.0.0.0/8");
});

test("no entropy-only rule: a random-looking token with no anchor is kept", async () => {
  await kept("the id is Qx7Lm2Pz9Wk4Rt8Yb3Nc6Vd1Hj5Fg0Sa and it is fine");
});

test("count mode: counts and cuts, never text, never a value", async () => {
  const input = `PGPASSWORD=s3cretPgPw ${SK} /home/alicea/x ${HELD}`;
  const out = await scrub(input, { mode: "count", held: [HELD] });
  assert.equal("text" in out, false);
  assert.deepEqual(out.counts, { "secret-assign": 1, "sk-key": 1, "home-path": 1, "held-value": 1 });
  const json = JSON.stringify(out);
  for (const value of ["s3cretPgPw", SK, "alicea", HELD]) assert.ok(!json.includes(value), value);
});

test("cut mode: each cut's span is in the input, and replacing the spans gives the output", async () => {
  const input = `a ${SK} b PGPASSWORD=s3cretPgPw c /home/alicea/x d erin.e@corp-mail.io`;
  const out = await cutOf(input);
  let rebuilt = "";
  let from = 0;
  for (const cut of out.cuts) {
    assert.ok(cut.start >= from && cut.end > cut.start);
    rebuilt += `${input.slice(from, cut.start)}[redacted:${cut.rule}]`;
    from = cut.end;
  }
  assert.equal(rebuilt + input.slice(from), out.text);
  assert.ok(!JSON.stringify(out.cuts).includes("s3cretPgPw"));
  assert.deepEqual(out.counts, { "sk-key": 1, "secret-assign": 1, "home-path": 1, email: 1 });
});

test("cut mode fails closed: a rule that throws gives {ok:false} and no text at all", async () => {
  const throwing = { id: "boom", kind: "label", restorable: true, find: () => { throw new Error(`leak ${SK}`); } };
  const out = await scrubWith([...SCRUB_RULES, throwing], `secret ${SK} here`, { mode: "cut" });
  assert.deepEqual(out, { ok: false, counts: {} });
  assert.ok(!JSON.stringify(out).includes(SK));
});

test("count mode does not swallow a throw (a scorer must not read zero for an error)", async () => {
  const throwing = { id: "boom", kind: "label", restorable: true, find: () => { throw new Error("boom"); } };
  await assert.rejects(scrubWith([throwing], "text", { mode: "count" }));
});

test("every cut's restorable follows its kind", async () => {
  const input = [`${SK}`, "PGPASSWORD=s3cretPgPw", "/home/alicea/x", HELD, "$ env", "PATH=/a", "HOME=/b", "SHELL=/c"].join("\n");
  const out = await cutOf(input, [HELD]);
  assert.ok(out.cuts.length >= 5);
  for (const cut of out.cuts) assert.equal(cut.restorable, RESTORABLE[cut.kind], cut.rule);
});

test("adversarial repeats finish (bounded gaps keep each rule linear)", async () => {
  for (const text of ["a@".repeat(50_000), "PGPASSWORD=".repeat(20_000), "/home/".repeat(30_000), `${"-----BEGIN RSA PRIVATE KEY-----\n".repeat(5_000)}`, "Authorization: ".repeat(20_000), "mysql -p".repeat(20_000), "10.".repeat(60_000), "fd00:".repeat(40_000)]) {
    const out = await scrub(text, { mode: "count" });
    assert.ok(out.counts);
  }
});

test("amendment 1a: each cut's outStart/outEnd is its replacement's span in the output; count mode has neither", async () => {
  const input = `a ${SK} b PGPASSWORD=s3cretPgPw c\n$ env\nPATH=/a\nHOME=/b\nSHELL=/c\nend`;
  const out = await cutOf(input);
  for (const cut of out.cuts) {
    const expected = cut.kind === "dump" ? `[redacted:${cut.rule} 3 lines]` : `[redacted:${cut.rule}]`;
    assert.equal(out.text.slice(cut.outStart, cut.outEnd), expected);
  }
  const counted = await scrub(input, { mode: "count" });
  for (const cut of counted.cuts) assert.ok(!("outStart" in cut) && !("outEnd" in cut));
});

test("amendment 1b: keep leaves a restorable cut's text in place, reported kept; it never keeps format, held or dump", async () => {
  const input = `mail erin.e@corp-mail.io key ${SK} held ${HELD} PGPASSWORD=s3cretPgPw\n$ env\nPATH=/a\nHOME=/b\nSHELL=/c`;
  const out = await cutOf(input, [HELD]);
  const all = await scrub(input, { mode: "cut", held: [HELD], keep: () => true });
  assert.equal(all.ok, true);
  assert.ok(all.text.includes("erin.e@corp-mail.io") && all.text.includes("PGPASSWORD=s3cretPgPw"), all.text);
  for (const value of [SK, HELD, "PATH=/a"]) assert.ok(!all.text.includes(value), value);
  assert.equal(all.cuts.length, out.cuts.length);
  for (const cut of all.cuts) {
    assert.equal(cut.kept === true, cut.restorable, cut.rule);
    assert.equal(all.text.slice(cut.outStart, cut.outEnd), cut.kept ? input.slice(cut.start, cut.end) : cut.kind === "dump" ? `[redacted:${cut.rule} 3 lines]` : `[redacted:${cut.rule}]`);
  }
  // keep sees each restorable cut alone and chooses: keep the email, cut the password.
  const asked = [];
  const some = await scrub(input, { mode: "cut", held: [HELD], keep: (cut) => (asked.push(cut.kind), cut.rule === "email") });
  assert.ok(asked.every((kind) => RESTORABLE[kind]), asked.join());
  assert.ok(some.text.includes("erin.e@corp-mail.io") && some.text.includes("PGPASSWORD=[redacted:secret-assign]"), some.text);
});

test("amendment 1b: a keep that throws fails closed", async () => {
  const out = await scrub("mail erin.e@corp-mail.io", { mode: "cut", keep: () => { throw new Error("no"); } });
  assert.deepEqual(out, { ok: false, counts: {} });
});
