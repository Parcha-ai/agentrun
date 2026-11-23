// `agentrun export AGENT --out DIR`: the agent's current revision written as a template package folder (GET
// /agents/{agent_id}/package), which `agentrun template validate` reads and any AgentRun applies. The server's report is
// printed whole: what kept the package from working elsewhere (`blocked`) and what the target sets up again (`remade`).
// With anything blocked, an agent the server does not export, or a folder not named as the package, nothing is written
// and the exit is 2.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Exits: 0 written; 2 refused (blocked, an agent the server does not export, an unknown one, a folder that holds files, a
 *  folder not named as the package). */
const REFUSED = 2;

export const EXPORT = {
  command: ["export"],
  pathParams: ["agent"],
  summary: "Write an agent's current revision as a template package folder, and say what the target sets up again",
  help: [
    ["AGENT", "the agent's id"],
    ["--out DIR", "the folder to write: a new one, or an empty one, named as the package is (another name is refused, naming the folder to use)"],
  ],
  options: { out: { type: "string" } },
  async run({ values, args, env, io, cli }) {
    if (!values.out) throw cli.fail(REFUSED, "--out DIR is the folder the package is written to.");
    const out = resolve(values.out);
    if (holdsFiles(out)) throw cli.fail(REFUSED, `${out} is not empty: export into a new folder, or an empty one.`);
    const client = cli.clientOf(cli.targetOf(values, env), io);
    const refused = client.refused;
    // The server's error goes to stderr as any command's does; an agent it does not export, or does not have, is a refusal.
    client.refused = (response, bytes) => {
      const code = refused(response, bytes);
      return [404, 409, 422].includes(response.status) ? REFUSED : code;
    };
    const { response, bytes, code } = await cli.request(client, { method: "GET", path: `/agents/${encodeURIComponent(args[0])}/package` });
    if (code !== undefined) {
      io.stderr.write("Nothing was written.\n");
      return code;
    }
    let answer;
    try {
      answer = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw cli.fail(1, `The server's answer (${response.status}) is not JSON.`);
    }
    const { name, sha256, files = [], report = {} } = answer ?? {};
    if (typeof name !== "string") throw cli.fail(1, `The server's answer (${response.status}) names no package.`);
    const blocked = report.blocked ?? [];
    const remade = report.remade ?? [];
    for (const [label, list] of [["Blocked", blocked], ["Set up again on the target", remade]]) {
      if (list.length) io.stderr.write(`${label}:\n${list.map((note) => `  ${note.kind} ${note.name}: ${note.reason}`).join("\n")}\n`);
    }
    // A package's folder is named as the package is (agent.md's name, which template validate checks), so a folder of
    // another name would hold a package that fails it. Neither name is changed here: renaming the package would deploy
    // another agent's name, and writing into a folder under --out would move where scripts find it.
    const stops = [];
    if (blocked.length) stops.push("the package would not work elsewhere until what is blocked is fixed on this agent");
    if (basename(out) !== name) stops.push(`a package's folder is named as the package is, ${name}, so ${out} would not pass agentrun template validate. Export to ${join(dirname(out), name)}`);
    if (stops.length) {
      client.print({ name, sha256, blocked, remade, folder: null });
      io.stderr.write(`Nothing was written: ${stops.join("; and ")}.\n`);
      return REFUSED;
    }
    // Every path checked before the first write: one that leaves the folder writes nothing.
    const written = files.map((file) => {
      const at = resolve(out, file.path);
      const inside = relative(out, at);
      if (isAbsolute(file.path) || !inside || inside.startsWith(`..${sep}`) || inside === "..") throw cli.fail(1, `The server's answer names a file outside the folder (${JSON.stringify(file.path)}): nothing was written.`);
      return { at, bytes: Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8") };
    });
    for (const file of written) {
      mkdirSync(dirname(file.at), { recursive: true });
      writeFileSync(file.at, file.bytes, { flag: "wx" });
    }
    if (!written.length) mkdirSync(out, { recursive: true });
    client.print({ name, sha256, blocked, remade, folder: out });
    if (io.stdout.isTTY) io.stderr.write(`Check it: agentrun template validate ${relative(process.cwd(), out) || "."}\n`);
    return 0;
  },
};

/** Whether `dir` exists and holds anything (a file in the way is refused the same). */
function holdsFiles(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error.code === "ENOTDIR") return true;
    throw error;
  }
}
