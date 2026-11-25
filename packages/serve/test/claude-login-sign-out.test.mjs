// Sign out of Claude Code's login on this machine (claude-login.ts signOutClaudeLogin, POST /settings/claude-login/sign-out).
// Turning the mode off leaves the login as the CLI keeps it, so Off then On reads the same account again with no
// sign-in: a person could neither sign in fresh nor switch accounts. Sign out ends a sign-in that waits, runs the CLI's
// own sign-out (`auth logout`) on AgentRun's own login folder, removes that folder (credentials, account, profiles, the
// refresh locks), the signed-in note kept for it and the runner's token reader, and turns the mode off; the next Turn on
// finds no login, and the console offers the sign-in. This machine's own login (the person's `~/.claude` or
// CLAUDE_CONFIG_DIR) is theirs: AgentRun never signs it out, and says to run `claude auth logout` there.
// A fake CLI stands in for the pinned one: signed in while its credentials file is in the credentials dir it is given,
// `auth login` writes that file and the account, `auth logout` removes both and exits as the test says.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { CLAUDE_LOGIN_ENV, CLAUDE_LOGIN_SETTING, LOGIN_ANSWERS_DIR, settingFor, startLoginHere } from "../dist/claude-login.js";
import * as login from "../dist/claude-login.js";
import { ClaudeSignIns } from "../dist/claude-sign-in.js";
import { loginTokensFor } from "../dist/claude-login-token.js";
import { MODEL_KEYS } from "../dist/model.js";
import { secretWritePath, serve, withEnv } from "./support.mjs";

secretWritePath(["GET", "PUT", "DELETE"], /^\/settings\/claude-login$/);
secretWritePath(["POST"], /^\/settings\/claude-login\/(login|sign-out)$/);

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_DEFAULT_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR", CLAUDE_LOGIN_ENV, ...MODEL_KEYS.map((row) => row.field)];
const CREDENTIALS = ".credentials.json";

/** A fake Claude Code CLI that keeps a login as the pinned one does on AgentRun's own folder: `auth login` writes the
 *  credentials file in CLAUDE_SECURESTORAGE_CONFIG_DIR and the account in CLAUDE_CONFIG_DIR's `.claude.json`;
 *  `auth status` reads signed in while that credentials file is there; `auth logout` removes both and exits with the code
 *  `logoutExits(code)` set (0 by default). `calls()`: each call's arguments and folders. */
async function fakeCli() {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-sign-out-cli-"));
  const [cli, record, rc] = ["claude", "calls.jsonl", "logout-rc"].map((name) => join(dir, name));
  writeFileSync(
    cli,
    `#!/bin/sh
printf '{"argv":"%s","home":"%s","config":"%s","secure":"%s"}\\n' "$*" "$HOME" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" >> '${record}'
case "$1 $2" in
  "auth login")
    mkdir -p "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR"
    printf '{"claudeAiOauth":{"accessToken":"not-a-secret","refreshToken":"not-a-secret-either","expiresAt":1893456000000}}' > "$CLAUDE_SECURESTORAGE_CONFIG_DIR/${CREDENTIALS}"
    printf '{"oauthAccount":{"emailAddress":"person@example.com"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
    exit 0 ;;
  "auth status")
    if [ -f "$CLAUDE_SECURESTORAGE_CONFIG_DIR/${CREDENTIALS}" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"person@example.com"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none"}'; exit 1 ;;
  "auth logout")
    rm -f "$CLAUDE_SECURESTORAGE_CONFIG_DIR/${CREDENTIALS}" "$CLAUDE_CONFIG_DIR/.claude.json"
    exit "$(cat '${rc}' 2>/dev/null || echo 0)" ;;
esac
`,
    { mode: 0o755 },
  );
  const calls = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { cli, dir, calls, logoutExits: (code) => writeFileSync(rc, String(code)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Waits until `done()` holds, 10 s at most. */
async function until(done, what) {
  const end = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const answers = (data) => (existsSync(join(data, LOGIN_ANSWERS_DIR)) ? readdirSync(join(data, LOGIN_ANSWERS_DIR)) : []);

test("Sign out of AgentRun's own login drops it: no credentials, account, signed-in note or token reader is left, the mode is off, and the next Turn on finds no login and offers the sign-in (Off then On alone kept the login)", { timeout: 180_000 }, async (t) => {
  const fake = await fakeCli();
  t.after(fake.cleanup);
  // The person's home is the test's own folder: nothing here reads or writes the machine's own Claude login.
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-sign-out-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  withEnv(t, { HOME: home, PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}` }, MODEL_VARS);
  const { api, data } = await serve(t, { faux: undefined, harnesses: false, runner: false });
  const folder = join(data, "claude-login");
  const signIns = () => fake.calls().filter((call) => call.argv === "auth login --claudeai").length;

  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_out");
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  await until(async () => (await api("GET", "/settings/claude-login")).body.state === "signed_in", "signed in through the CLI's sign-in");
  assert.ok(existsSync(join(folder, CREDENTIALS)), "the CLI keeps its credentials in AgentRun's own folder");
  assert.equal(answers(data).length, 1, "a signed-in answer is noted for runs");
  // The runner's token reader for the folder (claude-login-token.ts), held in this process as a runner beside it holds it.
  const reader = loginTokensFor({ dir: folder, profiles: join(folder, "anthropic") }, () => {});

  // The finding: Off then On reads the same account again, and no sign-in starts.
  assert.equal((await api("DELETE", "/settings/claude-login")).body.state, "off");
  const again = await api("PUT", "/settings/claude-login", { only_me: true });
  assert.equal(again.body.state, "signed_in", "Off then On keeps the login");
  assert.equal(signIns(), 1, "and starts no sign-in");

  const out = await api("POST", "/settings/claude-login/sign-out");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.confirmed, true, JSON.stringify(out.body));
  assert.equal(out.body.message, undefined, "a confirmed sign-out has no words to add");
  assert.equal(out.body.login.state, "off", "the mode is off");
  assert.doesNotMatch(JSON.stringify(out.body), /not-a-secret/);

  // The CLI's own sign-out ran once, at the login's folder (both its config and its credentials dir), in the person's home.
  const logouts = fake.calls().filter((call) => call.argv === "auth logout");
  assert.equal(logouts.length, 1, JSON.stringify(fake.calls()));
  assert.deepEqual([logouts[0].config, logouts[0].secure, logouts[0].home], [folder, folder, home]);
  // Nothing of the login is left: its folder, its signed-in note, the runner's reader of it.
  assert.equal(existsSync(join(folder, CREDENTIALS)), false, "no credentials file");
  assert.equal(existsSync(join(folder, ".claude.json")), false, "no account file");
  assert.equal(existsSync(folder), false, "AgentRun's own login folder is removed");
  assert.deepEqual(answers(data), [], "no signed-in note for the login");
  assert.notEqual(loginTokensFor({ dir: folder, profiles: join(folder, "anthropic") }, () => {}), reader, "the runner's token reader for the folder is dropped");

  // The next Turn on finds no login: the console shows the sign-in, which starts fresh.
  const on = await api("PUT", "/settings/claude-login", { only_me: true });
  assert.equal(on.body.state, "signed_out", JSON.stringify(on.body));
  assert.equal(on.body.can_start, true, "the sign-in is offered here");
  assert.equal(on.body.sign_in, undefined, "no sign-in started by the turn-on");
  assert.equal((await api("GET", "/settings/claude-login")).body.state, "signed_out");
  assert.equal(signIns(), 1, "no sign-in started by the sign-out or the turn-on");
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  await until(async () => (await api("GET", "/settings/claude-login")).body.state === "signed_in", "signed in again, fresh");
  assert.equal(signIns(), 2);
});

/** The routes' deps over stand-ins, for test `t`: the setting in `rows` (turned on at `place`), the pinned CLI a file,
 *  the CLI's sign-out answering `logout` (and noting each call in `logouts`), each sign-in waiting until stopped. */
async function rig(t, { place = "agentrun", logout = async () => true, env: extra = {} } = {}) {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-sign-out-"));
  const signIns = new ClaudeSignIns();
  t.after(async () => {
    await signIns.close();
    rmSync(data, { recursive: true, force: true });
  });
  const pinned = join(data, "claude");
  writeFileSync(pinned, "", { mode: 0o755 });
  const env = { HOME: data, PATH: "/usr/bin:/bin", ...extra };
  const rows = new Map([[CLAUDE_LOGIN_SETTING, settingFor(place, data)]]);
  const settings = { get: async (key) => rows.get(key) ?? null, put: async (key, value) => void rows.set(key, value), remove: async (key) => void rows.delete(key) };
  const logouts = [];
  const started = [];
  const cli = {
    claudeLoginCommand: () => "claude auth login",
    claudeLoginStatus: async () => ({ signedIn: false, method: "none" }),
    startClaudeLogin: (_cli, at) => {
      const one = { dir: at.dir, stopped: false };
      started.push(one);
      let end;
      const ended = new Promise((resolve) => { end = resolve; });
      return { ended, stop: () => { one.stopped = true; end({ end: "stopped" }); } };
    },
    claudeLogout: async (cliPath, at, options) => {
      logouts.push({ cli: cliPath, dir: at.dir, options });
      return logout();
    },
  };
  const deps = { signIns, settings, data, env, pinned: async () => pinned, refused: () => undefined, turn: (work) => work(), sameMachine: true, claude: async () => cli, saved: () => {}, changed: async () => {} };
  return { data, rows, deps, logouts, started, pinned };
}

/** AgentRun's own login folder in `data` with a credentials file and an account in it, as the CLI's sign-in leaves it. */
function signedInAt(data) {
  const folder = join(data, "claude-login");
  mkdirSync(join(folder, "anthropic"), { recursive: true });
  writeFileSync(join(folder, CREDENTIALS), "{}");
  writeFileSync(join(folder, ".claude.json"), "{}");
  return folder;
}

test("a sign-out on AgentRun's own login ends the sign-in that waits, runs the CLI's own sign-out with the pinned CLI, removes the folder and turns the mode off", async (t) => {
  assert.equal(typeof login.signOutClaudeLogin, "function", "claude-login.ts has the sign-out");
  const r = await rig(t);
  const folder = signedInAt(r.data);
  await startLoginHere(r.deps);
  assert.equal(r.started.length, 1);
  const out = await login.signOutClaudeLogin(r.deps);
  assert.deepEqual([out.confirmed, out.message, out.login.state], [true, undefined, "off"], JSON.stringify(out));
  assert.equal(r.started[0].stopped, true, "the sign-in that waited is ended");
  assert.deepEqual(r.logouts.map((one) => [one.cli, one.dir]), [[r.pinned, folder]], "the pinned CLI's own sign-out ran at AgentRun's folder");
  assert.equal(existsSync(folder), false, "the folder is removed");
  assert.equal(r.rows.has(CLAUDE_LOGIN_SETTING), false, "the mode is off");
});

test("a sign-out whose CLI does not confirm still removes the login and turns the mode off, and says the CLI didn't confirm", async (t) => {
  assert.equal(typeof login.signOutClaudeLogin, "function", "claude-login.ts has the sign-out");
  const r = await rig(t, { logout: async () => false });
  const folder = signedInAt(r.data);
  const out = await login.signOutClaudeLogin(r.deps);
  assert.equal(out.confirmed, false);
  assert.equal(out.message, login.LOGIN_SIGN_OUT_UNCONFIRMED);
  assert.match(out.message, /didn't confirm/);
  assert.equal(r.logouts.length, 1);
  assert.equal(existsSync(folder), false, "the folder is removed all the same");
  assert.equal(r.rows.has(CLAUDE_LOGIN_SETTING), false, "the mode is off all the same");
});

test("a sign-out of this machine's own login (the person's CLAUDE_CONFIG_DIR) is refused in words that say to run `claude auth logout` there: no CLI runs, nothing is removed, the mode stays on", async (t) => {
  assert.equal(typeof login.signOutClaudeLogin, "function", "claude-login.ts has the sign-out");
  const own = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-sign-out-own-"));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  writeFileSync(join(own, CREDENTIALS), "{}");
  const r = await rig(t, { place: "machine", env: { CLAUDE_CONFIG_DIR: own } });
  await assert.rejects(login.signOutClaudeLogin(r.deps), (error) => {
    assert.equal(error.code, "forbidden");
    assert.match(error.message, /claude auth logout/);
    assert.match(error.message, /your own/);
    return true;
  });
  assert.deepEqual(r.logouts, [], "no CLI sign-out ran on the person's own login");
  assert.ok(existsSync(join(own, CREDENTIALS)), "the person's own credentials are untouched");
  assert.equal(r.rows.get(CLAUDE_LOGIN_SETTING)?.place, "machine", "the mode stays on");
});

test("a sign-out with no login kept here (nothing signed in yet) runs no CLI, confirms, and turns the mode off", async (t) => {
  assert.equal(typeof login.signOutClaudeLogin, "function", "claude-login.ts has the sign-out");
  const r = await rig(t);
  rmSync(join(r.data, "claude-login"), { recursive: true, force: true });
  const out = await login.signOutClaudeLogin(r.deps);
  assert.deepEqual([out.confirmed, out.login.state], [true, "off"]);
  assert.deepEqual(r.logouts, []);
});
