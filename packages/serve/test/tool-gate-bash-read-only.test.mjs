// The read-only bash policy (bash-read-only.ts): an agent's own tool setting `bash: {policy: "read-only"}` (a template's
// `tool_policy: {bash: read-only}`) has the tool gate read each shell call's command before it runs or anyone is asked,
// and refuse, in words the model reads, one that could write, run code or read outside the run's folder. The allow and
// refuse tables are ported from the replay lane's read-only guard (its readonly-guard.ts and test_guard.mjs), with the
// changes the port makes: the check is lexical (the gate never reads the folder, so the guard's symlink and
// directory-operand cases are the computer's), a line with a cd joins its commands by && only, `git -C <dir>` inside the
// folder is allowed, a pipe may end in sed -n, and the guard's tool-call budget stays a template's setting, not the
// policy's. The gate holds the policy after a deny and a pin and before an allow or an ask, under approvals "never" too.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BASH_POLICIES, checkReadOnly, READ_ONLY_HINT, readOnlyReason } from "../dist/bash-read-only.js";
import { NOT_RUN } from "../dist/tool-gate.js";
import { canonicalToolSettings, settingsIssues } from "../dist/tool-plane.js";
import { compiled, PackageError, readPackage } from "../dist/templates.js";
import { runnerGate } from "./gate-support.mjs";
import { agent, scratch, serve } from "./support.mjs";

/** The run's folder by its names: its path on this machine, then the computer's. A command starts in the first. */
const FOLDER = ["/data/run/work", "/workspace"];
const HOME_FILE = join(os.homedir(), ".github-app-auth.sh");

/** Whether `command` is allowed from the folder; the reason it is refused, otherwise. */
const reasonOf = (command) => {
  try {
    checkReadOnly(command, FOLDER);
    return undefined;
  } catch (error) {
    return error.message;
  }
};
const allows = (command) => assert.equal(reasonOf(command), undefined, `should allow: ${command}`);
const refuses = (command, pattern) => {
  const reason = reasonOf(command);
  assert.ok(reason, `should refuse: ${JSON.stringify(command)}`);
  if (pattern) assert.match(reason, pattern, command);
};

// The guard's allowed table, ported.
const ALLOWED = [
  "git diff --stat HEAD~1 HEAD",
  "git log --oneline -5",
  "git log --format=%h/%s -3",
  "git log --oneline HEAD~3..HEAD",
  "git show HEAD:README.md",
  "git diff HEAD~1 -- packages",
  "git grep -n 'foo(' -- packages",
  "git blame -L 1,5 README.md",
  "git ls-files packages",
  "grep -r pattern .",
  "grep -rn 'api/v1' packages 2>/dev/null | head -20",
  "git log --oneline 2>&1 | head -5",
  "grep -n \"x = 1\" README.md",
  "sed -n '10,40p' README.md",
  "ls -la",
  "find . -name '*.ts'",
  "wc -l README.md",
  "cat /workspace/run-input.json",
  "cat /data/run/work/README.md",
  "cd /workspace && git log --oneline -3",
  "cd packages && ls",
  "cd packages && grep -rn x .",
  "cd packages && sed -n 1,5p ../README.md",
  "git status; git log -1",
  "git diff --stat && git log -1",
  "ls;",
  "grep -rn foo --include='*.ts' .",
  "grep -rn foo --include='*.ts' --exclude-dir=node_modules .",
  "grep -rn foo --exclude='*.md' .",
  "rg foo --include=\\*.ts .",
  "find . -name \\*.ts",
  "find packages -iname '*readme*'",
  "cat 'a;b'",
  "grep -n \"x; rm -rf .\" README.md",
  "grep -n 'a\\;b' README.md",
  "git log --oneline | grep fix | wc -l",
  "git log | sort | uniq -c | head",
  "grep -rn 'foo.*bar' packages",
  "grep -n \"a[0-9]+\" README.md",
  "grep -rn -e 'x?y' .",
  "grep -rn --regexp='x?y' .",
  "rg 'a.*b' packages",
  "rg -t ts 'a.*b' packages",
  "grep -rn -m 3 'foo.*' packages",
  "grep -rn foo\\.\\* packages",
  "git log --oneline | grep 'fix.*guard'",
  "diff README.md README.md",
  "rg --files packages",
  "grep -e. README.md",
  "grep -ie x README.md",
  "grep -fREADME.md x .",
  "grep -n -e foo -e bar README.md",
  "wc -l README.md packages/serve/index.ts",
  "grep -- '-x' README.md",
  "grep -rn -- 'a.*' packages",
  "cat -- README.md",
  "grep -e -x README.md",
  "git log --oneline -- packages",
  "sed -n 1,3p -- README.md",
  "git log --grep fix -3",
  "git cat-file -p HEAD",
  "cat .git",
  "git show HEAD:.git/config",
];

// The guard's refused table, ported (its symlink, directory-operand and budget cases are not the policy's: see above).
const REFUSED = [
  "find . -name x -exec cat /etc/hostname ;",
  "find . -name x -exec cat /etc/hostname +",
  "find / -name hostname",
  "find . -fprint /tmp/x",
  "find .. -name '*.sh'",
  "git log --output=/tmp/x",
  "git diff --no-index /etc/hostname README.md",
  "git show HEAD:../../etc/hostname",
  "git archive HEAD",
  "git grep -f /etc/hostname",
  "grep -f /etc/hostname README.md",
  "grep -r pattern /etc",
  "grep -r pattern ../..",
  "grep -rn x --include=y /",
  "ls /",
  "ls ..",
  "cat README.md /etc/hostname",
  "wc -l /etc/hostname",
  "sed -n 1p /etc/hostname",
  "sed -n 'e cat /etc/hostname' README.md",
  "sed -n '1w /tmp/x' README.md",
  "sed 's/a/b/e' README.md",
  `head -c 100 ${HOME_FILE}`,
  "git -P log",
  "git config --get user.name",
  "git submodule status",
  "git log -p --ext-diff",
  "env cat /etc/hostname",
  "xargs cat",
  "awk '{print}' README.md",
  "python3 -c 1",
  "node -e 1",
  "curl http://x",
  "git rev-parse --git-dir",
  "tail -n 5 /proc/self/environ",
  "less README.md",
  "git log --format=%H --output=x",
  "git diff HEAD~1 --output=/tmp/z",
  "grep -r --exclude-from=/etc/hostname x .",
  "cd ../.. ; cat x",
  "cd ../.. && cat x",
  "cd /tmp && cat x",
  "cd /etc && cat hostname",
  "cd .. ; ls",
  "find . -name '*' -exec cat {} +",
  "grep -r --include=* x /etc",
  "grep -r --include='*.ts' x ../..",
  "grep --include=../../x -r y .",
  "ls &",
  "ls || cat /etc/hostname",
  "ls\ncat /etc/hostname",
  "ls\rcat /etc/hostname",
  "cd packages && cat ../../../../etc/hostname",
  "grep x . | sh",
  "ls | xargs cat",
  "ls | tee f",
  "ls > f",
  "ls >> f",
  "cat < /etc/hostname",
  "ls 2> f",
  "ls &> f",
  "ls 2>/dev/nullx",
  "git log | cat /etc/hostname",
  "git log | git show HEAD:x",
  "ls | cd /",
  "cat *.ts",
  "cat '*.ts'",
  "ls packages/*",
  "find . -path './packages/*'",
  "find . -name 'a/*'",
  "git diff -- 'packages/*.ts'",
  "cat README.md\u0000/etc/hostname",
  "ls \u0000x",
  "cat \u0001README.md",
  "grep 'a\u0000' README.md",
  "diff -r packages packages",
  "diff -ur packages packages",
  "diff --recursive packages packages",
  "diff --recur packages packages",
  "sort --files0-from=x",
  "sort --files0-from x",
  "sort --files0=x",
  "wc --files0-from=x",
  "wc --files0-from=README.md",
  "wc --files0 x",
  "find . -files0-from x",
  "grep -e. .env",
  "grep -f.env x .",
  "grep -ie. .env",
  "grep -e x .env",
  "grep -e/etc/passwd README.md",
  "grep -ie/etc/passwd README.md",
  "grep -f ../../x y .",
  "rg -e. .env",
  "grep -- '-x' /etc/passwd",
  "grep -n -- -x /etc/passwd",
  "rg -- '-x' /etc/passwd",
  "cat -- /etc/hostname",
  "head -- /etc/hostname",
  "sed -n 1p -- /etc/hostname",
  "ls -- /",
  "git show -- ../../x",
  "wc -- -x /etc/hostname",
  "sort -- /etc/passwd",
  "grep -e x -- -y /etc/passwd",
  "grep -rf /etc/passwd .",
  "grep --exclude-from /etc/passwd x .",
  "grep -e /etc/passwd README.md",
  "uniq -- -a -b",
  "sort -mo out README.md",
  "sort -uT /tmp README.md",
  "tail -fn 5 README.md",
  "rg -iz x .",
  "rg --hostname-bin=sh x .",
  "git grep -iO x",
  "git blame -wS revs README.md",
  "git ls-files -tX x",
  "git log -pO x",
  "grep -- x ../../etc/hostname",
  `cat -- ${HOME_FILE}`,
  "grep -rn foo.* packages",
  "grep 'x' packages/*.ts",
  "grep -r 'a.*' /etc",
  "grep -rn 'foo'.* packages",
  "grep -n x 'README*'",
  "grep -f 'pat*' README.md",
  "grep -rn -e x?y .",
  "rg -g 'pkg*' 'x' .",
  "grep -m '3*' x README.md",
  "grep --include=src/*.ts x .",
  "rg -g '*.ts' foo",
  "cd",
  "cd -",
  "ls ; cd / ; ls",
  "cd packages | ls",
  "git blame --contents=/etc/hostname README.md",
  "git blame --contents=~/.github-app-auth.sh README.md",
  "git blame --contents /etc/hostname README.md",
  "git blame --cont=/etc/hostname README.md",
  "git blame --contents README.md README.md",
  "cat /proc/self/environ",
  "head -c 2000 /proc/1/environ",
  "sed -n p ../../x",
  "sed -n 1p ../../x",
  "git -c core.pager=less log",
  "git -c core.pager=sh log",
  "git --config-env=core.pager=X log",
  "git blame -S /etc/hostname README.md",
  "git blame --ignore-revs-file=/etc/hostname README.md",
  "git grep -O x",
  "git log --out=x",
  "git diff --no-index /etc/passwd README.md",
  "git diff -O/etc/hostname",
  "git ls-files --exclude-from=/etc/hostname",
  "git ls-files -X /etc/hostname",
  "git cat-file --filters HEAD:README.md",
  "git cat-file --textconv HEAD:README.md",
  "git rev-parse --resolve-git-dir /etc",
  "git log --show-signature",
  "git -C / status",
  "git log --some-future-option=/etc/hostname",
  "git log --some-future-option /etc/hostname",
  "git --git-dir=/etc log",
  "git log -- /etc",
  "git show HEAD:../../x",
  "git fetch origin",
  "git checkout HEAD~1",
  "grep -f/etc/hostname x",
  "grep x ~/.bashrc",
  `cat ${HOME_FILE}`,
  "cat /etc/passwd",
  "ls /proc",
  "wc --files0-from=/etc/hostname",
  "diff README.md /etc/hostname",
  "cat .env",
  "grep -n KEY config/.env.local",
  "git show HEAD:.env",
  "echo pwned > PWNED",
  "touch x",
  "rm -rf .",
  "sed -i 's/a/b/' README.md",
  "sed -n '1e id' README.md",
  "find . -exec sh -c id ;",
  "find . -delete",
  "ls $(echo /)",
  "cat `echo /etc/passwd`",
  "ls; id",
  "ls && id",
  "python3 x.py",
  "bash -c ls",
  "curl https://example.com",
  "rg --pre sh x",
  "sort -o out README.md",
  "tail -f README.md",
];

test("the guard's allowed table: each read command passes", () => {
  for (const command of ALLOWED) allows(command);
});

test("the guard's refused table: each command that writes, runs code, redirects, expands or reads outside the folder is refused", () => {
  for (const command of REFUSED) refuses(command);
});

test("the shapes particle-1 tries: grep piped into head or sed -n, sed -n ranges, cat, find without -exec are allowed", () => {
  allows("grep -rn x packages | head -40");
  allows("grep -rn x packages | sed -n '1,40p'");
  allows("git diff HEAD~1 -- packages | sed -n 1,200p");
  allows("sed -n '1,40p' README.md");
  allows("sed -n '$p' README.md");
  allows("git merge-base HEAD origin/main");
  allows("git rev-parse HEAD");
  allows("git show --stat HEAD");
  allows("git diff abc123 def456 -- packages/serve/src/tool-gate.ts");
  allows("cat packages/serve/src/tool-gate.ts | head -80");
  allows("find packages -name '*.test.mjs' -type f");
  allows("tail -n 20 README.md");
  allows("git grep -n -C 3 'pinRefusal' -- packages");
});

test("command substitution, redirection, unquoted globs and code runners are refused with a reason the model can act on", () => {
  refuses("cat $(git ls-files)", /\$ and backticks|"\$" is not allowed/);
  refuses('echo "$(id)"', /\$ and backticks are not allowed/);
  refuses("ls `pwd`", /not allowed/);
  refuses("git diff > f", /redirection is not allowed \(only 2>\/dev\/null and 2>&1\)/);
  refuses("echo x > f", /redirection is not allowed/);
  refuses("cat < README.md", /redirection is not allowed/);
  refuses("cat packages/*.ts", /the glob packages\/\*\.ts is not allowed here/);
  refuses("npm test", /"npm" is not a read command this policy runs/);
  refuses("node index.js", /"node" is not a read command/);
  refuses("./run.sh", /is not a read command/);
  refuses("make", /"make" is not a read command/);
  refuses("python -m pytest", /"python" is not a read command/);
  refuses("sh -c ls", /"sh" is not a read command/);
  refuses("git diff HEAD~1 | tee out", /tee cannot take piped input \(pipe only into head, tail, sed/);
  refuses("grep -rn x . | xargs rm", /xargs cannot take piped input/);
  refuses("sed -n '/x/p' README.md", /sed's script must be one N,Mp range/);
  refuses("sed '1,40p' README.md", /sed needs -n/);
  refuses("find . -name x -exec rm {} ;", /not allowed/);
});

test("an unquoted glob is refused everywhere, as the shell would expand it into the folder's file names (a file named -delete after find -name *delete)", () => {
  for (const command of ["find . -name *delete", "find . -iname *.ts", "grep -rn foo --include=*.ts .", "grep -rn foo --exclude=*.md .", "grep -rn foo --exclude-dir=node* .", "rg foo --include=*.ts ."]) refuses(command, /the glob .* is not allowed here \(quote it/);
  allows("find . -name '*delete'");
  allows("find . -name \"*delete\"");
  allows("grep -rn foo --include=\\*.ts .");
});

test("a file an option reads is held to the path rule in every spelling: --file=, --exclude-from=, rg --ignore-file", () => {
  for (const command of ["grep --file=credentials.json README.md", "grep --file=id_rsa README.md", "rg --file=.env x .", "grep --exclude-from=credentials.json x .", "grep --exclude-from credentials.json x .", "rg --ignore-file=id_rsa x .", "rg --ignore-file id_rsa x .", "grep --file=../../x README.md"]) refuses(command);
  allows("grep --file=patterns.txt README.md");
  allows("grep --exclude-from=ignore.txt -rn x .");
  allows("rg --ignore-file ignore.txt x .");
});

test("a refused long option is refused with every prefix GNU getopt takes: sort --out=f is sort --output=f", () => {
  for (const command of ["sort --out=README.md README.md", "sort --o=README.md README.md", "sort --outp README.md README.md", "sort --comp=sh README.md", "sort --temp=x README.md", "wc --files0=x", "tail --fol README.md", "tail --ret README.md", "diff --to=README.md README.md", "diff --recur packages packages", "grep --deref x .", "rg --pre-g x .", "git log --out=x", "git log --ou=x"]) {
    refuses(command, /not allowed/);
  }
  // A word an option takes as its value is text, never an option: searching for "--pre" or "-iz" reads.
  allows("rg -e '--pre' .");
  allows("grep -rn -e --output README.md");
  allows("grep --regexp --follow README.md");
  allows("rg -e -iz .");
  refuses("rg -e x --pre sh .", /rg --pre is not allowed/);
  // An option that is no prefix of a refused one still reads.
  allows("sort --reverse README.md");
  allows("sort --numeric-sort README.md");
  allows("tail --lines=5 README.md");
  allows("diff --unified README.md README.md");
  allows("git log --oneline -3");
});

test("git -C: allowed to a directory inside the folder, its later paths read from there; refused anywhere else", () => {
  allows("git -C packages log --oneline -3");
  allows("git -C packages diff HEAD~1 -- ../README.md");
  allows("git -C /workspace/packages status");
  allows("git -C packages -C serve log -1");
  allows("git --no-pager -C packages show --stat HEAD");
  refuses("git -C .. log", /git -C \.\. is outside the run's folder/);
  refuses("git -C /etc status", /outside the run's folder/);
  refuses("git -C packages show HEAD:../../x", /outside the run's folder/);
  refuses("git -C packages diff -- ../../etc/hostname", /outside the run's folder/);
  refuses("git -C", /git -C needs a directory/);
  refuses("git -Cpackages log", /only --no-pager and -C <dir> may precede a read subcommand/);
  refuses("git -C 'pack*' log", /a glob is not allowed/);
});

test("a line with a cd joins its commands by && only: a cd that fails would leave the commands after a ; where the policy never looked", () => {
  refuses("cd packages ; sed -n 1,5p ../README.md", /joins its commands with && only/);
  refuses("cd a && ls ; cat ../x", /joins its commands with && only/);
  allows("cd packages && cd serve && ls");
  // An option-shaped word is cd's option, not a directory: cd -- or cd -P alone goes to $HOME, outside the folder.
  for (const command of ["cd -- && cat profile.txt", "cd -P && cat profile.txt", "cd -L && ls", "cd -P packages && ls", "cd -e"]) refuses(command, /cd .* is not allowed|cd needs exactly one directory/);
  allows("cd packages;");
});

test("the never-open list holds inside the folder: .env, keys, .ssh and credentials are refused", () => {
  for (const command of ["cat .env.production", "head deploy/server.pem", "cat id_rsa", "ls .ssh", "cat a/.ssh/config", "cat .npmrc", "cat .netrc", "cat .git-credentials", "cat credentials.json", "cat tls/site.key"]) refuses(command, /never-open list/);
});

/** A run's gate whose revision sets bash's policy (`policy`, read-only by default; null: none), over the server's `settings`. */
const gateWith = ({ settings = { bash: { permission: "allow" } }, policy = "read-only", permission, harness = "pi", approvals = "ask", approvers = true } = {}) =>
  runnerGate({ settings, harness, approvals, approvers, overrides: { bash: { ...(policy === null ? {} : { policy }), ...(permission ? { permission } : {}) } }, root: FOLDER[0] });

test("the gate: under read-only a read command goes on to bash's permission, any other is refused unsent in the policy's words", async () => {
  const gate = gateWith();
  assert.equal(await gate.decide("bash", { command: "git diff HEAD~1 -- packages | head -40" }), "allow");
  const refused = await gate.decide("bash", { command: "npm test" });
  assert.equal(refused.deny, `bash is read-only for this agent, so this call was refused: "npm" is not a read command this policy runs. ${NOT_RUN} ${READ_ONLY_HINT}`);
  // No policy: the same command is bash's permission's alone.
  assert.equal(await gateWith({ policy: null }).decide("bash", { command: "npm test" }), "allow");
});

test("the gate: the policy holds under approvals never, before an ask, and after a deny", async () => {
  // approvals never lifts bash's ask to an allow, never the policy's refusal.
  const never = gateWith({ settings: { bash: { permission: "ask" } }, approvals: "never" });
  assert.equal(await never.decide("bash", { command: "ls" }), "allow");
  assert.match((await never.decide("bash", { command: "npm test" })).deny, /^bash is read-only for this agent/);
  // Under ask, a refused command is refused before anyone is asked; a read one is asked.
  const asks = gateWith({ settings: { bash: { permission: "ask" } } });
  assert.equal(await asks.decide("bash", { command: "ls" }), "ask");
  assert.match((await asks.decide("bash", { command: "rm -rf ." })).deny, /^bash is read-only for this agent/);
  // A deny comes first, in its own words.
  const denied = gateWith({ settings: { bash: { permission: "deny" } } });
  assert.match((await denied.decide("bash", { command: "ls" })).deny, /^Permission denied: bash is set to deny on this server/);
  // The agent's own allow beside its policy: the policy still refuses.
  assert.match((await gateWith({ settings: {}, permission: "allow" }).decide("bash", { command: "echo x > f" })).deny, /redirection is not allowed/);
});

test("the gate: the background tools that start or feed a process are refused under read-only; the watchers pass", async () => {
  const gate = gateWith();
  for (const name of ["bash_background", "bash_input", "mcp__hands__bash_background"]) {
    assert.match((await gate.decide(name, { command: "ls" })).deny, /is not offered: a read-only shell runs one command at a time, in the foreground, with bash/, name);
  }
  for (const name of ["bash_output", "bash_list", "bash_signal"]) assert.equal(await gate.decide(name, { id: "1" }), "allow", name);
});

test("the gate: every harness's name for the shell is held to the policy, and an argv is read as the command it runs", async () => {
  const claude = gateWith({ harness: "claude-agent" });
  assert.equal(await claude.decide("mcp__hands__bash", { command: "ls" }), "allow");
  assert.match((await claude.decide("mcp__hands__bash", { command: "npm test" })).deny, /"npm" is not a read command/);
  assert.match((await claude.decide("Bash", { command: "node -e 1" })).deny, /"node" is not a read command/);
  assert.match((await claude.decide("Bash", { command: "ls", run_in_background: true })).deny, /in the background is not allowed/);
  const codex = gateWith({ harness: "codex" });
  assert.equal(await codex.decide("shell", { command: ["bash", "-lc", "grep -rn x . | head -5"] }), "allow");
  assert.equal(await codex.decide("shell", { command: ["rg", "-n", "a.*b", "packages"] }), "allow");
  assert.match((await codex.decide("shell", { command: ["bash", "-lc", "npm test"] })).deny, /"npm" is not a read command/);
  assert.match((await codex.decide("shell", { command: ["cat", "*.ts"] })).deny, /the glob \*\.ts is not allowed/);
  assert.match((await codex.decide("shell", { command: ["ls"], workdir: "/etc" })).deny, /its workdir \/etc is outside the run's folder/);
  assert.equal(await codex.decide("shell", { command: ["cat", "README.md"], workdir: "/workspace/packages" }), "allow");
  // A workdir the tool may not honor: the command must hold from the folder too, so ../x from packages is refused.
  assert.match((await codex.decide("shell", { command: ["cat", "../README.md"], workdir: "/workspace/packages" })).deny, /outside the run's folder/);
  assert.match((await gateWith().decide("bash", { command: "cat ../x", cwd: "packages" })).deny, /outside the run's folder/);
  assert.match((await gateWith().decide("bash", {})).deny, /it carries no command this policy can read/);
});

test("the gate: a policy this server does not know refuses every shell call (fail closed); other tools are untouched", async () => {
  const gate = gateWith({ policy: "read-mostly" });
  assert.match((await gate.decide("bash", { command: "ls" })).deny, /this agent's bash policy "read-mostly" is not one this server knows \(read-only\)/);
  assert.equal(await gateWith({ settings: { bash: { permission: "allow" }, read: { permission: "allow" } } }).decide("read", { path: "../../etc/passwd" }), "allow", "a policy on bash reads bash's calls alone");
});

test("readOnlyReason: undefined for a read command, the reason otherwise", () => {
  assert.equal(readOnlyReason("bash", { command: "ls" }, FOLDER), undefined);
  assert.equal(readOnlyReason("bash", { command: "rm x" }, FOLDER), "\"rm\" is not a read command this policy runs");
  assert.deepEqual(BASH_POLICIES, ["read-only"]);
});

test("settings: bash's policy is an agent's own, on bash alone, one of the policies; the one form keeps it", () => {
  assert.deepEqual(settingsIssues({ bash: { policy: "read-only", permission: "allow" } }, "tool_settings", "agent"), []);
  assert.deepEqual(settingsIssues({ bash: { policy: "read-only" } }).map((issue) => [issue.field, issue.reason]), [["bash.policy", "not_allowed"]], "never the server's");
  assert.deepEqual(settingsIssues({ read: { policy: "read-only" } }, "tool_settings", "agent").map((issue) => [issue.field, issue.reason]), [["tool_settings.read.policy", "not_allowed"]]);
  assert.deepEqual(settingsIssues({ bash: { policy: "readonly" } }, "tool_settings", "agent").map((issue) => [issue.field, issue.reason]), [["tool_settings.bash.policy", "not_an_option"]]);
  assert.equal(JSON.stringify(canonicalToolSettings({ bash: { policy: "read-only", permission: "allow" } })), JSON.stringify({ bash: { permission: "allow", policy: "read-only" } }));
});

test("the API: POST /v2/agents keeps bash's policy and GET answers it; the server's settings refuse one", async (t) => {
  const { api } = await serve(t, {});
  const made = await api("POST", "/agents", agent("reviewer", { tool_settings: { bash: { policy: "read-only" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual((await api("GET", "/agents/reviewer")).body.definition.tool_settings, { bash: { policy: "read-only" } });
  const bad = await api("POST", "/agents", agent("bad", { tool_settings: { bash: { policy: "nope" } } }));
  assert.equal(bad.status, 422);
  assert.ok(JSON.stringify(bad.body).includes("tool_settings.bash.policy"), JSON.stringify(bad.body));
  assert.equal((await api("PUT", "/settings/tools", { bash: { policy: "read-only" } })).status, 422);
});

const REVIEW = new URL("../templates/code-review/", import.meta.url).pathname;

/** A copy of the code-review package with its manifest's `tools: [read]` line replaced by `lines`, read. */
async function packageWith(t, lines) {
  const dir = join(await scratch(t), "code-review");
  mkdirSync(dir, { recursive: true });
  cpSync(REVIEW, dir, { recursive: true });
  const manifest = join(dir, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("tools: [read]", lines));
  try {
    return { p: readPackage(dir), problems: [] };
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return { problems: error.problems };
  }
}

test("a template's tool_policy: apply writes bash's policy in the agent's tool settings; a bad one is refused by the validator", async (t) => {
  const { p } = await packageWith(t, "tools: [read, bash]\ntool_policy: { bash: read-only }");
  assert.deepEqual(p.toolPolicy, { bash: "read-only" });
  const made = compiled(p, { repo: "acme/widgets" }, { mcp: [], defaultTools: [], grants: [] });
  assert.deepEqual(made.agent.definition.tool_settings, { bash: { policy: "read-only" } });
  for (const [lines, pattern] of [
    ["tools: [read]\ntool_policy: { bash: read-only }", /tool_policy\.bash: the package's tools grant no bash/],
    ["tools: [read, bash]\ntool_policy: { bash: readonly }", /tool_policy is \{bash: read-only\}/],
    ["tools: [read, bash]\ntool_policy: { read: read-only }", /tool_policy is \{bash: read-only\}/],
  ]) {
    const { problems } = await packageWith(t, lines);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${lines}: ${JSON.stringify(problems)}`);
  }
});
