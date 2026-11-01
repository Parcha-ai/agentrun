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
  if (context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit"))) {
    // A node that says whether anything it can reach holds a decision key (Jev's or Parallel's): this process's
    // environment (as its tools get it), the environment the kernel shows, the descriptor the server hands the keys on,
    // and a program it starts.
    // "..., once <file> exists." holds it until the test has made that file.
    const canary = JSON.stringify(context);
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
    const submit = faux.message(faux.toolCall("submit", { answer: 42 }), { stopReason: "toolUse" });
    const ms = first.includes("Take your time") ? 60_000 : first.includes("Answer soon") ? 1_500 : 0;
    return ms ? slow(faux, ms, "").then((m) => (m.stopReason === "aborted" ? m : submit)) : submit;
  }
  // A follow-up that asks the person: the question its turn ends on.
  if (users.length > 1 && last === "Ask me now.") return answered ? faux.message("Asked.") : faux.message(faux.toolCall("ask_person", { question: "Which one?" }), { stopReason: "toolUse" });
  // Asks the person through ask_person; for an agent without it the call fails, and the reply goes on without asking.
  if (first.includes("Pick a region")) {
    if (users.length === 1 && !answered) return faux.message(faux.toolCall("ask_person", { question: "Which region should I use?" }), { stopReason: "toolUse" });
    return faux.message(JSON.stringify({ region: users.length === 1 ? "us" : last.trim() }));
  }
  // The run's process says which of these it sees: the server's token must not reach it, the rest must.
  if (first.includes("Which variables do you see?")) {
    const seen = (name) => `${name} ${process.env[name] ? "set" : "unset"}`;
    return faux.message(["AGENTRUN_TOKEN", "TOKEN_COPY", "OPENAI_API_KEY", "AGENT_MODEL_PRICE"].map(seen).join("; "));
  }
  // Fetches each URL its first message lists with fetch_page (or the tool it names), one per turn, then says so.
  const fetches = /^Fetch these pages(?: with (\w+))?: (.*)$/s.exec(first);
  if (fetches) {
    const urls = JSON.parse(fetches[2]);
    return results < urls.length ? faux.message(faux.toolCall(fetches[1] ?? "fetch_page", { url: urls[results] }), { stopReason: "toolUse" }) : faux.message("Fetched.");
  }
  if (browse) return results === 0 ? faux.message(faux.toolCall("snapshot", {}), { stopReason: "toolUse" }) : faux.message(`Seen: ${textOf(context.messages.at(-1))}`);
  // A follow-up whose answer starts only after a minute: a stop before then cuts it before its first content.
  if (users.length > 1 && last === "Slowly, please.") return slow(faux, 60_000, "Done slowly.");
  if (first.includes("six times seven")) return faux.message([faux.thinking("six times seven"), faux.text("The answer is 42.")]);
  if (first.includes("Write the report")) {
    if (answered) return faux.message("I wrote report.md.");
    return faux.message(faux.toolCall("write", { path: "report.md", content: "# Report\n\nThe answer is 42.\n" }), { stopReason: "toolUse" });
  }
  if (last.includes("Take your time")) return slow(faux, 60_000, "Done slowly.");
  // Answers only once it is stopped: the answer lands after the stop, the race the server must not read as an answer.
  if (first.includes("Answer when stopped") && users.length === 1) return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("Stopped, but here is the answer.")), { once: true }));
  if (first.includes("Answer soon") && users.length === 1) return slow(faux, 1_500, "Soon.");
  // "Answer once <file> exists.": the test says when, by making the file.
  const once = /^Answer once (\S+) exists\.$/.exec(first);
  if (once && users.length === 1) return untilExists(once[1]).then(() => faux.message("Now."));
  if (first.includes("Fail")) return faux.message("", { stopReason: "error", errorMessage: "the faux model failed on purpose" });
  if (first.includes("as JSON")) return faux.message(first.includes("wrongly") ? '{"answer": "forty-two"}' : '```json\n{"answer": 42}\n```');
  return faux.message(`On ${last}: done.`);
}
