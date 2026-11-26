// Our MCP server's name across a run's starts. Written for AgentRun.
//  - Under a recipe that names it per start (mcpServerName: `ar` and 6 hex digits), the first start's name is kept with
//    the run (SERVER_STREAM) and given again at each later start. An agent that keeps, with a session, the name it was
//    first given still names our calls under ours after a load: Cursor 2026.11.13 does, titling a resumed run's call
//    `ar7e621c-web_fetch` though that start had named the server `arc50d18`, and the title tie asked it as another's.
//  - A name kept that long could be aimed at: a config the agent reads that declares a server under it (one the agent
//    itself wrote in a turn) would pass for ours. So at each start, a config the recipe lists (mcpConfigs) that declares
//    a server under the kept name has it refused for that start: a fresh name is minted and kept, the run is told which
//    file declared it, and a call titled under the old name is that server's, asked at the host's gate. A config that
//    can't be read through (past MCP_CONFIG_MAX, or a read that fails) or that does not parse as JSON but names the kept
//    name (an agent may read comments or trailing commas) counts as declaring it: the name is never kept on a guess. The
//    file is never edited: what is in it is the run's.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { START_SERVER } from "./calls.js";
import { mcpConfigPath } from "./recipe.js";

/** The native stream a run's kept server name is in: one `{ name }` record per name minted for it, the last the one in
 *  use; a record that also says `refused` and `file` minted that name because `file` declared a server under `refused`. */
export const SERVER_STREAM = "acp.server";

/** How a config has the kept name refused: it declares a server under it (`declares`), it does not parse as JSON but
 *  names it (`names`), or it is there and could not be read through (`unread`: past MCP_CONFIG_MAX, or the read failed). */
export type Refusal = "declares" | "names" | "unread";

/** A record of SERVER_STREAM. */
export interface ServerRecord {
  readonly name: string;
  readonly refused?: string;
  readonly file?: string;
  readonly how?: Refusal;
}

/** A name a run may keep: mcpServerName's per-start form, and nothing else a record could say. */
export const KEPT_SERVER = new RegExp(`^${START_SERVER}$`);

/** The most bytes of an MCP config read for a server's name; a larger one is not read, and declares nothing. */
export const MCP_CONFIG_MAX = 1024 * 1024;

/** The first of `configs` (the recipe's mcpConfigs: `~/<path>` in `home`, any other in `work`) that has `name` refused,
 *  and how (Refusal): its `mcpServers` object declares a server named `name`, as the recipe spells it; or it does not
 *  parse as JSON and its text has `name` in it; or it is a file that is larger than MCP_CONFIG_MAX or whose read failed.
 *  Undefined when none does. One that is not there or is no file declares nothing; `log` is told of each one refused
 *  unread or unparsed. Nothing is written. */
export function configDeclaring(name: string, configs: readonly string[], home: string, work: string, log: (message: string, fields?: Record<string, unknown>) => void): { readonly file: string; readonly how: Refusal } | undefined {
  for (const config of configs) {
    const where = mcpConfigPath(config);
    if (!where) continue;
    const file = join(where.in === "home" ? home : work, where.path);
    let text: string;
    try {
      const stat = statSync(file, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) continue;
      if (stat.size > MCP_CONFIG_MAX) {
        log("acp: an MCP config the agent reads is too large to read for our server's name; the name is refused", { config, bytes: stat.size });
        return { file: config, how: "unread" };
      }
      text = readFileSync(file, "utf8");
    } catch (error) {
      log("acp: an MCP config the agent reads could not be read for our server's name; the name is refused", { config, error: error instanceof Error ? error.message : String(error) });
      return { file: config, how: "unread" };
    }
    let servers: unknown;
    try {
      servers = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
    } catch {
      if (!text.includes(name)) continue;
      log("acp: an MCP config the agent reads does not parse as JSON and names our server; the name is refused", { config });
      return { file: config, how: "names" };
    }
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers) && Object.hasOwn(servers, name)) return { file: config, how: "declares" };
  }
  return undefined;
}

/** The run's notice that `label`'s config `file` has `refused` refused (`how`: it declares a server under it, names it
 *  unparsed, or could not be read), the name the run's earlier starts gave ours: this start gives ours `name`, and a
 *  call under `refused` is that server's. */
export function nameRefused(label: string, file: string, refused: string, name: string, how: Refusal = "declares"): string {
  const what = how === "unread" ? `${file} could not be read to see whether it declares an MCP server named ${refused}` : how === "names" ? `${file} does not parse as JSON and names ${refused}` : `${file} declares an MCP server named ${refused}`;
  return `${what}, the name this run gave its own tools' server before, so ${label} could take that server's calls for ours: this start names ours ${name}, and a call ${label} names under ${refused} is that server's, not ours, and asks you first. The file was left as it is.`;
}
