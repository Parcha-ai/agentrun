// A faux model for the tests and the conformance scenarios: replies chosen from the conversation, no key, no network.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** Resolves after `ms`, or as an aborted reply as soon as the turn is stopped. */
const slow = (faux, ms, text) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(faux.message(text)), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });

const untilExists = async (file) => {
  const { access } = await import("node:fs/promises");
  while (!(await access(file).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
};

/** The key timeline-key-words.test.mjs holds, which the provider errors above echo. */
const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;

export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const [first = "", last = ""] = [users[0], users.at(-1)];
  const answered = context.messages.at(-1)?.role === "toolResult";
  // A workflow's model node: it delivers its record through `submit`, slowly when its input says so.
  const results = context.messages.filter((m) => m.role === "toolResult").length;
  // Browses with the `browser` tool: a snapshot of the page, then (an agent) its text as the answer, or (a node) the record.
  const browse = first.includes("Browse the example page");
  // Files the page as evidence with browser_read, then delivers the record.
  const read = first.includes("Read the example page");
  // "Use the learned workflow <name> on <question>.": the run's learned_workflow, then its answer as the tool said it.
  const learned = /Use the learned workflow (\S+) on (.+?)\.$/.exec(first);
  if (learned && !context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit")) && !context.tools?.some((tool) => tool.name === "submit")) {
    return results === 0 ? faux.message(faux.toolCall("learned_workflow", { name: learned[1], input: { question: learned[2] } }), { stopReason: "toolUse" }) : faux.message(`Ran: ${textOf(context.messages.at(-1))}`);
  }
  // A workflow's model node on pi-durable (its submit tool added by a system message), or in a session of its own (a
  // learned workflow's: agentrun-pi's host runner, its tools in the context).
  if (context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit")) || context.tools?.some((tool) => tool.name === "submit")) {
    // A node that says whether anything it can reach holds a decision key (Jev's or Parallel's): this process's
    // environment (as its tools get it), the environment the kernel shows, the descriptor the server hands the keys on,
    // and a program it starts.
    // "..., once <file> exists." holds it until the test has made that file.
    const canary = JSON.stringify(context);
    // A node whose provider echoed the key it was sent (timeline-key-words.test.mjs holds that value as a key).
    if (canary.includes("Fail echoing a held key")) return faux.message("", { stopReason: "error", errorMessage: '401 {"message":"Key not-a-secret-echoed-key-0123 is not valid"}' });
    // A node whose record carries the key as a property NAME, nested too; and two names that redact to the same one.
    if (canary.includes("Submit the held key as a name")) {
      if (answered) return faux.message("Submitted.");
      return faux.message(faux.toolCall("submit", { note: "ok", n: 1, dict: { [CUT_KEY]: "found", nested: { [CUT_KEY]: "deep", kept: "yes" } } }), { stopReason: "toolUse" });
    }
    // A node whose record carries an all-digit held key as a number (final-answer-redact.test.mjs holds it as the model key).
    if (canary.includes("Submit the held number")) {
      if (answered) return faux.message("Submitted.");
      return faux.message(faux.toolCall("submit", { note: "ok", n: Number(["1234", "5678", "9012"].join("")), kept: 42 }), { stopReason: "toolUse" });
    }
    // A node whose record carries the key in a string field (final-answer-redact.test.mjs holds CUT_KEY as a key).
    if (canary.includes("Submit the held key")) {
      if (answered) return faux.message("Submitted.");
      return faux.message(faux.toolCall("submit", { note: `kept ${CUT_KEY} here`, n: 7 }), { stopReason: "toolUse" });
    }
    // A node whose model request a provider refused (401), in pi-ai's words.
    if (canary.includes("Fail with a refused key")) return faux.message("", { stopReason: "error", errorMessage: '401: {"message":"User not found","code":401}' });
    // A node that says which decision keys its process was handed on their descriptor: names only, never a value.
    if (canary.includes("Report the decision keys")) {
      if (answered) return faux.message("Submitted.");
      return import(new URL("../../dist/decisions.js", import.meta.url).href).then(({ handedKeys }) => faux.message(faux.toolCall("submit", { names: Object.keys(handedKeys(process.env)).sort() }), { stopReason: "toolUse" }));
    }
    if (canary.includes("Report the canary")) {
      if (answered) return faux.message("Submitted.");
      const gate = /Report the canary once (\S+?) exists\./.exec(canary)?.[1];
      return (async () => {
        const [{ CANARY: JEV }, { CANARY: PARALLEL }, { readFile }, { readFileSync, readlinkSync }, { spawnSync }] = await Promise.all([import("./faux-jev.mjs"), import("./faux-parallel.mjs"), import("node:fs/promises"), import("node:fs"), import("node:child_process")]);
        const holds = (text) => typeof text === "string" && (text.includes(JEV) || text.includes(PARALLEL));
        if (gate) await untilExists(gate);
        const environ = await readFile("/proc/self/environ", "utf8").catch(() => "");
        const fd = process.env.AGENTRUN_SERVE_DECISION_KEY_FD;
        const sub = spawnSync("sh", ["-c", `${fd ? `[ -e /proc/$$/fd/${fd} ] && echo FD_OPEN; ` : ""}env`], { encoding: "utf8" });
        // Whether the descriptor is a Unix socket, as the handed one is (one end of a socket pair): Node opens 3 to about
        // 20 for itself, none a Unix socket, and a closed low number is soon one of them. Here and in a Node program it starts.
        const handedSocket = (fd) => {
          try {
            const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`))?.[1];
            return inode !== undefined && readFileSync("/proc/self/net/unix", "utf8").split("\n").some((line) => line.trim().split(/\s+/)[6] === inode);
          } catch {
            return false;
          }
        };
        // And a Node program, as a tool's effect would start one: what its environment holds and whether it got the
        // descriptor.
        const node = spawnSync(process.execPath, ["-e", `const { readFileSync, readlinkSync } = require("fs"); process.stdout.write(JSON.stringify({ leaked: Object.values(process.env).some((v) => v && (v.includes(${JSON.stringify(JEV)}) || v.includes(${JSON.stringify(PARALLEL)}))), fd_open: ${fd ? `(${handedSocket})(${fd})` : "false"} }))`], { encoding: "utf8" });
        const nodeSaw = JSON.parse(node.stdout || "{}");
        // The env this process gives its tools (ToolHost.env, made by withSecrets from the secrets fd 3 handed over):
        // the module the run preloaded, so the same instance and the same secrets.
        const secrets = await import(new URL("../../dist/secrets.js", import.meta.url).href);
        const hostEnv = secrets.withSecrets(process.env);
        return faux.message(faux.toolCall("submit", {
          leaked: Object.values(process.env).some(holds) || holds(environ),
          key_set: process.env.TYPESAFE_API_KEY !== undefined || process.env.PARALLEL_API_KEY !== undefined,
          fd_open: fd ? handedSocket(fd) : false,
          sub_leaked: holds(sub.stdout),
          sub_fd_open: sub.stdout.includes("FD_OPEN"),
          node_leaked: nodeSaw.leaked !== false,
          node_fd_open: nodeSaw.fd_open !== false,
          host_env_leaked: ["TYPESAFE_API_KEY", "PARALLEL_API_KEY"].some((name) => holds(hostEnv[name]) || holds(secrets.secret(name))),
        }), { stopReason: "toolUse" });
      })();
    }
    if ((browse || read) && results === 0) return faux.message(faux.toolCall(read ? "browser_read" : "snapshot", {}), { stopReason: "toolUse" });
    if ((browse || read) && results === 1) return faux.message(faux.toolCall("submit", { answer: 42 }), { stopReason: "toolUse" });
    if (answered) return faux.message("Submitted.");
    // In a session of its own (agentrun-pi's host runner), submit takes the DSL's envelope: the record under `value`.
    const submitTool = [...context.messages.flatMap((m) => m.toolsAdded ?? []), ...(context.tools ?? [])].find((tool) => tool.name === "submit");
    const params = submitTool?.parameters;
    const enveloped = Boolean(params?.properties?.value && Object.keys(params.properties).length === 1 && params.required?.includes("value"));
    const submit = faux.message(faux.toolCall("submit", enveloped ? { value: { answer: 42 } } : { answer: 42 }), { stopReason: "toolUse" });
    // "Answer once <file> exists.": the node submits when the test has made that file.
    const gate = /Answer once (\S+?) exists\./.exec(first)?.[1];
    if (gate) return untilExists(gate).then(() => submit);
    const ms = first.includes("Take your time") ? 60_000 : first.includes("Answer soon") ? 1_500 : 0;
    return ms ? slow(faux, ms, "").then((m) => (m.stopReason === "aborted" ? m : submit)) : submit;
  }
  // A follow-up that asks the person: the question its turn ends on.
  if (users.length > 1 && last === "Ask me now.") return answered ? faux.message("Asked.") : faux.message(faux.toolCall("ask_person", { question: "Which one?" }), { stopReason: "toolUse" });
  // Asks the person through ask_person; for an agent without it the call fails, and the reply goes on without asking.
  // "Pick a region once <file> exists." asks only once the test has made that file, and then makes `<file>.asked`.
  if (first.includes("Pick a region")) {
    const gate = /^Pick a region once (\S+) exists\.$/.exec(first)?.[1];
    const ask = () => faux.message(faux.toolCall("ask_person", { question: "Which region should I use?" }), { stopReason: "toolUse" });
    // It says it asked by `<file>.asked`: the run's own store is its process's alone while it lives.
    if (users.length === 1 && !answered) return gate ? untilExists(gate).then(async () => ((await import("node:fs")).writeFileSync(`${gate}.asked`, ""), ask())) : ask();
    return faux.message(JSON.stringify({ region: users.length === 1 ? "us" : last.trim() }));
  }
  // The run's process says which of these it sees: the server's token must not reach it, the rest must.
  if (first.includes("Which variables do you see?")) {
    const seen = (name) => `${name} ${process.env[name] ? "set" : "unset"}`;
    return faux.message(["AGENTRUN_TOKEN", "TOKEN_COPY", "OPENAI_API_KEY", "AGENT_MODEL_PRICE"].map(seen).join("; "));
  }
  // A follow-up that fetches the public page once more with web_fetch, then says so.
  if (users.length > 1 && last === "Fetch again.") {
    const since = context.messages.length - 1 - context.messages.findLastIndex((m) => m.role === "user");
    return since === 0 ? faux.message(faux.toolCall("web_fetch", { url: "http://public.example/" }), { stopReason: "toolUse" }) : faux.message("Fetched again.");
  }
  // Runs monid's /slow, which holds until it is stopped; then, or on a follow-up (the run stopped), says so.
  if (first.includes("Run monid's /slow.")) return results === 0 && users.length === 1 ? faux.message(faux.toolCall("monid_run", { provider: "faux", endpoint: "/slow" }), { stopReason: "toolUse" }) : faux.message("Ran.");
  // Searches the web once for what follows "Search the web for ", then answers with the search's answer.
  if (first.includes("Search the web for ")) {
    const query = first.slice(first.indexOf("Search the web for ") + "Search the web for ".length).replace(/\.$/, "");
    return results === 0 ? faux.message(faux.toolCall("web_search", { query, n: 2 }), { stopReason: "toolUse" }) : faux.message(`Found: ${textOf(context.messages.at(-1))}`);
  }
  // Quotes a key read from a file the test names (so the prompt never holds it): in its thinking, in its text (base64),
  // in a tool call's arguments, then in its answer (timeline-redact-all.test.mjs holds that value as a key).
  // Records the first message it was given, exactly as the model received it, then answers (user-row-redact.test.mjs).
  const record = /Record what you got in (\S+) now\.$/.exec(first);
  if (record) {
    process.getBuiltinModule("node:fs").writeFileSync(record[1], first);
    return faux.message("Recorded.");
  }
  // Answers with a console link and the key in a file, in a URL's query (answer-urls.test.mjs).
  const linked = /^Answer with the console link and the key in (\S+)$/.exec(first);
  if (linked) {
    const key = process.getBuiltinModule("node:fs").readFileSync(linked[1], "utf8").trim();
    return faux.message(`Open http://127.0.0.1:7340/#/runs/01a1a961-3257-7131-a652-c6fb78880244?x=1 and see https://api.example/v1?k=${key}&y=2 for it.`); // key-gate: loopback-rule a console link an agent's answer gives, as text
  }
  const quote = /^Quote the key in (\S+)$/.exec(first);
  if (quote) {
    const key = process.getBuiltinModule("node:fs").readFileSync(quote[1], "utf8").trim();
    if (results === 0) return faux.message([faux.thinking(`I hold ${key} now.`), faux.text(`The key is ${Buffer.from(key).toString("base64")}.`), faux.toolCall("read", { path: `notes/${key}.txt` })], { stopReason: "toolUse" });
    return faux.message(`Done with ${key}.`);
  }
  // Runs monid's /person/enrich (priced at once), then /slow (held until stopped, or cut by a crash), then answers.
  if (first.includes("Run monid's /person/enrich, then its slow endpoint.")) {
    const steps = [["monid_run", { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }], ["monid_run", { provider: "faux", endpoint: "/slow", input: {} }]];
    return results < steps.length ? faux.message(faux.toolCall(...steps[results]), { stopReason: "toolUse" }) : faux.message("Ran.");
  }
  // Runs monid's /person/enrich with no inspect first (held at the run allowance): one call in the first turn, then, in
  // each turn after it (a raised cap's follow-up), one more call, or two with "twice"; then answers with the last result.
  if (first.includes("Run monid's /person/enrich, called again after a raise")) {
    const calls = first.includes("twice") ? 2 * users.length - 1 : users.length;
    return results < calls ? faux.message(faux.toolCall("monid_run", { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }), { stopReason: "toolUse" }) : faux.message(`Ran: ${textOf(context.messages.at(-1))}`);
  }
  // Finds, reads and runs a monid endpoint, a call per turn, under the tools' wire names; then answers with the run's result.
  if (first.includes("Enrich with monid")) {
    const steps = [["monid_discover", { query: "enrich a person" }], ["monid_inspect", { provider: "faux", endpoint: "/person/enrich" }], ["monid_run", { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }]];
    return results < steps.length ? faux.message(faux.toolCall(...steps[results]), { stopReason: "toolUse" }) : faux.message(`Ran: ${textOf(context.messages.at(-1))}`);
  }
  // Uses the skill that fits, as a run told of its skills on demand does: reads the SKILL.md whose path its system prompt
  // names, then answers with the skill's FORMAT-LINE as the file has it. A prompt that already holds the skill's text says
  // BODY-INLINED; one that names no skill's file says so.
  if (first.startsWith("Use the skill that fits:")) {
    const sectionText = (part) => (typeof part === "string" ? part : Array.isArray(part) ? part.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
    const system = [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m), ...Object.values(m.sections ?? {}).map(sectionText)])].join("\n");
    if (/^FORMAT-LINE:/m.test(system)) return faux.message("BODY-INLINED");
    if (!answered) {
      const path = /\((\.agents\/skills\/[^)\s]+\/SKILL\.md)\)/.exec(system)?.[1];
      return path ? faux.message(faux.toolCall("read", { path }), { stopReason: "toolUse" }) : faux.message("NO SKILL LISTED");
    }
    return faux.message(/^FORMAT-LINE:.*$/m.exec(textOf(context.messages.at(-1)))?.[0] ?? "NO FORMAT IN THE FILE");
  }
  // Reads each path its first message lists with read, one per turn, then says so; "once <file> exists" holds the first
  // read until the test has made that file (and planted what the reads need).
  const reads = /^Read these paths(?: once (\S+) exists)?: (.*)$/s.exec(first);
  if (reads) {
    const paths = JSON.parse(reads[2]);
    const call = () => faux.message(faux.toolCall("read", { path: paths[results] }), { stopReason: "toolUse" });
    if (results >= paths.length) return faux.message("Read them.");
    return reads[1] && results === 0 ? untilExists(reads[1]).then(call) : call();
  }
  // Fetches each URL its first message lists with fetch_page (or the tool it names), one per turn, then says so.
  const fetches = /^Fetch these pages(?: with (\w+))?: (.*)$/s.exec(first);
  if (fetches) {
    const urls = JSON.parse(fetches[2]);
    return results < urls.length ? faux.message(faux.toolCall(fetches[1] ?? "fetch_page", { url: urls[results] }), { stopReason: "toolUse" }) : faux.message("Fetched.");
  }
  // Researches: web_search, then web_fetch of the public page, then report.md citing the page it read, then says so.
  const topic = /^Research (.+) on the web and write report\.md\.$/s.exec(first)?.[1];
  if (topic) {
    const found = (index) => JSON.parse(textOf(context.messages.filter((m) => m.role === "toolResult")[index]));
    if (results === 0) return faux.message(faux.toolCall("web_search", { query: topic, n: 2 }), { stopReason: "toolUse" });
    if (results === 1) return faux.message(faux.toolCall("web_fetch", { url: "http://public.example/" }), { stopReason: "toolUse" });
    if (results === 2) return faux.message(faux.toolCall("write", { path: "report.md", content: `# ${topic}\n\n${found(1).text?.includes("forty-two") ? "The answer is forty-two" : "No answer"} (${found(1).title}, ${found(1).url}).\n` }), { stopReason: "toolUse" });
    return faux.message("Wrote report.md.");
  }
  // Searches the web once for what its first message says, with web_search, then says so.
  const query = /^Search the web for (.+)$/s.exec(first)?.[1];
  if (query) return results === 0 ? faux.message(faux.toolCall("web_search", { query, n: 3 }), { stopReason: "toolUse" }) : faux.message("Searched.");
  // A follow-up that browses once more: a snapshot, then what it saw.
  if (browse && users.length > 1 && last === "Browse the example page again.") return answered ? faux.message(`Seen again: ${textOf(context.messages.at(-1))}`) : faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" });
  // "Browse the example page once <file> exists." answers, its browser still open, only once the test has made that file.
  const browseGate = /^Browse the example page once (\S+) exists\.$/.exec(first)?.[1];
  if (browse && results > 0 && browseGate) return untilExists(browseGate).then(() => faux.message(`Seen: ${textOf(context.messages.at(-1))}`));
  if (browse) return results === 0 ? faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" }) : faux.message(`Seen: ${textOf(context.messages.at(-1))}`);
  // A follow-up whose answer starts only after a minute: a stop before then cuts it before its first content.
  if (users.length > 1 && last === "Slowly, please.") return slow(faux, 60_000, "Done slowly.");
  // "Write a file, then signal <file> and wait.": a write, then a request that makes <file> as it starts and answers only
  // after a minute, so a stop cuts it after the tool round; a follow-up then answers at once.
  const signalWait = /^Write a file, then signal (\S+) and wait\.$/.exec(first);
  if (signalWait) {
    if (users.length > 1) return faux.message("Went on.");
    if (results === 0) return faux.message(faux.toolCall("write", { path: "a.md", content: "a" }), { stopReason: "toolUse" });
    return import("node:fs").then(({ writeFileSync }) => (writeFileSync(signalWait[1], ""), slow(faux, 60_000, "Done slowly.")));
  }
  // Review F3: an answer; a follow-up whose turn says something with a call, then holds (the person stops it); a last
  // follow-up answered with nothing (as a /compact is).
  if (first.includes("Answer, reread, then compact.")) {
    if (users.length === 1) return faux.message("Report written.");
    if (users.length === 2) return results === 0 ? faux.message([faux.text("Let me reread the report first."), faux.toolCall("read", { path: "report.md" })], { stopReason: "toolUse" }) : slow(faux, 60_000, "Reread it.");
    return faux.message("");
  }
  // Holds its first answer until the file exists; the person's follow-up, placed at that answer's end with it, is
  // answered in a run of its own.
  const held = /Hold the answer until (\S+)\./.exec(first)?.[1];
  if (held) return users.length > 1 ? faux.message("Answer 2.") : untilExists(held).then(() => faux.message("Answer 1."));
  if (first.includes("six times seven")) return faux.message([faux.thinking("six times seven"), faux.text("The answer is 42.")]);
  // An answer of nothing: one empty thinking block and one empty text block, a stop with no tool call.
  if (first.includes("Answer with nothing")) return faux.message([faux.thinking(""), faux.text("")]);
  if (first.includes("Write the report")) {
    if (answered) return faux.message("I wrote report.md.");
    return faux.message(faux.toolCall("write", { path: "report.md", content: "# Report\n\nThe answer is 42.\n" }), { stopReason: "toolUse" });
  }
  // A call that succeeds, then one that fails (the file is not there), then the answer.
  if (first.includes("Write a note, then read a missing one")) {
    if (results === 0) return faux.message(faux.toolCall("write", { path: "note.md", content: "noted" }), { stopReason: "toolUse" });
    if (results === 1) return faux.message(faux.toolCall("read", { path: "missing.md" }), { stopReason: "toolUse" });
    return faux.message("Wrote one, missed one.");
  }
  // One request that calls a tool, then the run's process exits on the next, without releasing the run.
  if (first.includes("Crash after one request")) {
    if (results === 0) return faux.message(faux.toolCall("write", { path: "note.md", content: "noted" }), { stopReason: "toolUse" });
    process.exit(3);
  }
  // A tool name past what the agent store keeps (256 characters): pi answers that no such tool exists.
  if (first.includes("Call a tool with a long name")) return results === 0 ? faux.message(faux.toolCall("t".repeat(300), {}), { stopReason: "toolUse" }) : faux.message("Called it.");
  if (last.includes("Take your time")) return slow(faux, 60_000, "Done slowly.");
  // Answers only once it is stopped: the answer lands after the stop, the race the server must not read as an answer.
  if (first.includes("Answer when stopped") && users.length === 1) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("Stopped, but here is the answer.")), { once: true }));
  if (first.includes("Answer soon") && users.length === 1) return slow(faux, 1_500, "Soon.");
  // "Answer once <file> exists.": the test says when, by making the file.
  const once = /^Answer once (\S+) exists\.$/.exec(first);
  if (once && users.length === 1) return untilExists(once[1]).then(() => faux.message("Now."));
  // A follow-up whose answer stops at its length (max output tokens): text, no tool call, stopReason "length".
  if (first.includes("Stop the follow-up at its length") && users.length > 1) return faux.message("The follow-up's answer, cut at its length", { stopReason: "length" });
  // A provider error long enough to be cut on its Timeline row, echoing the key it was sent across the summary's cut (its
  // 497 characters, after "Model request failed: ") and the text's (1997), 20 of its characters before each; and one that echoes the key base64-encoded (timeline-key-words.test.mjs holds
  // CUT_KEY as a key).
  if (first.includes("Fail across the cut")) return faux.message("", { stopReason: "error", errorMessage: `${"a".repeat(455)}${CUT_KEY}${"b".repeat(1977 - 455 - CUT_KEY.length)}${CUT_KEY} end` });
  // The key echoed on line after line, far past what a Timeline row shows.
  if (first.includes("Fail repeating a held key")) return faux.message("", { stopReason: "error", errorMessage: `${CUT_KEY}\n`.repeat(200) });
  // The key echoed with a line break in its middle, as a provider that wraps long lines would.
  if (first.includes("Fail with a wrapped key")) return faux.message("", { stopReason: "error", errorMessage: `401 {"message":"Key ${CUT_KEY.slice(0, 18)}\n${CUT_KEY.slice(18)} is not valid"}` });
  if (first.includes("Fail echoing an encoded key")) return faux.message("", { stopReason: "error", errorMessage: `401 {"message":"Key ${Buffer.from(CUT_KEY).toString("base64")} is not valid"}` });
  // An answer that quotes the held key, plainly and base64-encoded (final-answer-redact.test.mjs holds CUT_KEY as a key).
  if (first.includes("Answer quoting the held key.")) return faux.message(`Here it is: ${CUT_KEY} and ${Buffer.from(CUT_KEY).toString("base64")}. The rest stays.`);
  // A long answer (about 50 KB) that quotes the held key near its end.
  if (first.includes("Answer at length quoting the held key.")) return faux.message(`${"word ".repeat(10_000)}near the end ${CUT_KEY} done.`);
  // A workflow's llm call that answers with the held key, and one whose provider echoes it in its error (graph-redact.test.mjs).
  if (first.includes("Answer the graph with the held key.")) return faux.message(`Graph: ${CUT_KEY} here, and ${["later", "held", "zyxwvutsrq"].join("-")} too.`);
  if (first.includes("Fail the graph call echoing the held key.")) return faux.message("", { stopReason: "error", errorMessage: `500 {"message":"Key ${CUT_KEY} is not valid"}` });
  // A provider error of about 4 KB that quotes the held key again and again, so one copy sits across any cut at 2000.
  if (first.includes("Fail the graph call at length.")) return faux.message("", { stopReason: "error", errorMessage: `500 ${`${CUT_KEY} `.repeat(110)}` });
  // About 1 MB of "sk-" runs, a space every 8 K: each run is one long sk- shape that every third character starts again.
  if (first.includes("Answer with a megabyte of sk- runs.")) return faux.message(`${"sk-".repeat(2730)} `.repeat(128));
  // An answer quoting a value no key holds yet (final-answer-redact.test.mjs saves it as one after the run).
  if (first.includes("Answer quoting the later key.")) return faux.message(`Later: ${["not-a-secret", "later-key-0123456789abcdef"].join("-")} ends here.`);
  // A provider error that is no 401 but echoes the key it was sent.
  if (first.includes("Fail echoing a held key")) return faux.message("", { stopReason: "error", errorMessage: '500 {"message":"Key not-a-secret-echoed-key-0123 is not valid"}' });
  // A provider's content filter stopping the answer, in pi-ai's words for it on each API (its stop reason "error"): the
  // Responses API's incomplete answer, Chat Completions' finish_reason, and the Messages API's refusal with no explanation.
  const filtered = /Stop on the content filter \((responses|completions|anthropic)\)/.exec(first)?.[1];
  if (filtered) return faux.message("", { stopReason: "error", errorMessage: { responses: "Response incomplete: content_filter", completions: "Provider finish_reason: content_filter", anthropic: "The model refused to complete the request" }[filtered] });
  // pi-ai's words for a provider that refused the key (401), as a model request on any tier would end.
  if (first.includes("Fail with a refused key")) return faux.message("", { stopReason: "error", errorMessage: '401: {"message":"User not found","code":401}' });
  // A final stop of the model's own with no text (turn-record.test.mjs): one empty text block (and an empty thinking
  // block), only a thinking block, or no content at all; as
  // the first answer, or as a follow-up's after an answer with text.
  if (first.includes("Answer with one empty text block.")) return faux.message([faux.thinking(""), faux.text("")]);
  if (first.includes("Answer only by thinking.") || last === "Now answer only by thinking.") return faux.message([faux.thinking("Nothing to add.")]);
  if (first.includes("Answer with no content.") || last === "Now answer with no content.") return faux.message([]);
  // A stop at the length limit (the model's max output tokens): text and no tool call, as a first answer or a follow-up's.
  if (first.includes("Answer until the length runs out.") || last === "Now answer until the length runs out.") return faux.message("Cut short: the length ran out", { stopReason: "length" });
  // One answer asks for two fetches (no such tool here, so both fail), then the turn stops with no text.
  if (first.includes("Fetch two pages at once and both fail")) {
    if (results === 0) return faux.message([faux.toolCall("web_fetch", { url: "http://a.example/" }), faux.toolCall("web_fetch", { url: "http://b.example/" })], { stopReason: "toolUse" });
    return faux.message([]);
  }
  // A long tool phase on pi: two fetches, each held until its file exists (faux-web-hold.mjs), then the answer.
  const gated = /Fetch the pages held until (\S+) and (\S+)\./.exec(first);
  if (gated) return results < 2 ? faux.message(faux.toolCall("fetch_page", { url: `http://public.example/hold?until=${encodeURIComponent(gated[results + 1])}` }), { stopReason: "toolUse" }) : faux.message("Fetched both.");
  if (first.includes("Fail")) return faux.message("", { stopReason: "error", errorMessage: "the faux model failed on purpose" });
  if (first.includes("as JSON")) return faux.message(first.includes("wrongly") ? '{"answer": "forty-two"}' : '```json\n{"answer": 42}\n```');
  // Asked at a learning run's end what to keep (learn/reflect.ts reflectPrompt): nothing.
  if (last.startsWith("The task is done. Before the run ends")) return faux.message("No notes.");
  return faux.message(`On ${last}: done.`);
}
