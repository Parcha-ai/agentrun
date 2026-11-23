// `agentrun share RUN --dry-run`: what sharing a run would send, shown and sent nowhere. The run's share bundle (GET
// /runs/{run_id}/export: one agentrun.share/1 document, every string of it cut by the server's scrubber) is fetched from
// the server this CLI talks to, checked against the sha256 it names, summed up (its cuts by kind, how many a preview may
// restore, its sha256 and size, what it left out), and the server's preview page, <origin>/share/RUN, is opened in this
// machine's browser as `agentrun open` opens the console (or its link printed where none opens). Nothing of the run's
// words is printed: counts, kinds and the paths the bundle already cut, no more.
// `--out FILE` writes the bundle's bytes as the server sent them (0600, never over a file); `--restore` asks the server to
// keep restorable cuts in place (a stateless re-export); `--expect SHA` refuses a bundle whose sha256 is another, the
// guard the page's publish command carries. Publishing itself comes with a share host: until then, share without
// --dry-run or --out exits 2 and sends nothing.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canOpen, launchOpener } from "./service.mjs";

/** Exits: 0 shown (or written); 1 the server failed the export, refused it as withheld, or sent a bundle that is not
 *  what it names (or not the one --expect names); 2 bad usage, a run the server does not have or that has not ended, a
 *  restore it refuses, a bundle over its cap, an --out file that exists, or no --dry-run. */
const REFUSED = 2;
const FORMAT = "agentrun.share/1";
const CUT_ID = /^c_[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NOTHING = "Nothing was written or opened.";
/** The order kinds are summed up in: those a preview may restore, then those it never does. */
const KINDS = ["label", "personal", "jev", "format", "held", "dump"];

/** The canonical JSON the server writes the bundle in and hashes (serve's validate.ts `stable`): keys sorted, no spaces. */
const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value));

/** The server's error message for a refusal, or undefined: its words, never its JSON. */
const messageOf = (bytes) => {
  try {
    const message = JSON.parse(bytes.toString("utf8"))?.error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : undefined;
  } catch {
    return undefined;
  }
};

/** What the export's refusals say here, and their exits; any other status is the CLI's own refusal. */
const REFUSALS = {
  400: (said) => [REFUSED, said ?? "The server refused the restore ids."],
  404: (said, run) => [REFUSED, said ?? `The server has no run ${run}.`],
  409: (said, run) => [REFUSED, `${said ?? `The run ${run} has not ended.`} Share it once it ends.`],
  413: (said) => [REFUSED, said ?? "The run's bundle is over the server's cap."],
  403: (said) => [1, `The run is withheld: ${said ?? "this server can't read what the run was handed"}`],
  500: () => [1, "The export failed closed on the server: nothing of the run was shown. The server's log names why (export_failed)."],
};

/** The summary of a bundle: counts and kinds, the paths it left out (already cut), never a word of the run. */
function summaryOf(run, bundle, bytes) {
  const cuts = Array.isArray(bundle.cuts) ? bundle.cuts : [];
  const counts = new Map();
  for (const cut of cuts) counts.set(String(cut?.kind), (counts.get(String(cut?.kind)) ?? 0) + 1);
  return {
    run,
    format: bundle.format,
    sha256: bundle.sha256,
    bytes: bytes.length,
    cuts: { total: cuts.length, restorable: cuts.filter((cut) => cut?.restorable === true).length, by_kind: Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1))) },
    restored: Array.isArray(bundle.restored) ? bundle.restored.length : 0,
    omitted: (Array.isArray(bundle.omitted) ? bundle.omitted : []).map((entry) => ({ what: entry?.what, ...(typeof entry?.path === "string" ? { path: entry.path } : {}), why: entry?.why })),
  };
}

/** The lines a person reads on stderr. */
function linesOf({ cuts, restored, omitted, sha256, bytes }) {
  const rank = (kind) => (KINDS.includes(kind) ? KINDS.indexOf(kind) : KINDS.length);
  const byKind = Object.keys(cuts.by_kind).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).map((kind) => `${cuts.by_kind[kind]} ${kind}`).join(", ");
  const lines = [`${cuts.total} cut${cuts.total === 1 ? "" : "s"}${cuts.total ? `: ${byKind}` : ""}; ${cuts.restorable} restorable, ${restored} restored.`];
  if (omitted.length) lines.push(`Omitted: ${omitted.map((entry) => `${entry.path ?? entry.what} (${entry.why})`).join(", ")}.`);
  lines.push(`Bundle: sha256 ${sha256}, ${bytes} bytes.`);
  return lines;
}

/** The command, given what opens a browser here; SHARE (below) binds it to this machine. */
export function shareOf({ launch = launchOpener, platform = process.platform } = {}) {
  return {
    command: ["share"],
    pathParams: ["run"],
    route: "GET /runs/{run_id}/export; the page it opens is <origin>/share/{run_id}",
    summary: "Show what sharing a run would send (--dry-run): its bundle checked and summed up, its page opened here; nothing is published",
    help: [
      ["RUN", "the run's id: an ended run"],
      ["--dry-run", "fetch the run's share bundle, print its summary and open its preview page; nothing is sent anywhere"],
      ["--out FILE", "write the bundle as the server sent it, byte for byte (0600, never over a file); alone, it opens nothing"],
      ["--restore IDS", "cut ids to keep in place, comma-separated (restorable ones only: a label, personal or jev cut)"],
      ["--expect SHA", "refuse a bundle whose sha256 is another (the page's publish command carries it)"],
      ["--no-open", "open no browser; print the page's link"],
    ],
    options: { "dry-run": { type: "boolean" }, out: { type: "string" }, restore: { type: "string" }, expect: { type: "string" }, open: { type: "boolean" } },
    async run({ values, args, env, io, cli }) {
      const [run] = args;
      if (!values["dry-run"] && values.out === undefined) throw cli.fail(REFUSED, "publishing comes with a share host; --dry-run shows the page (and --out FILE writes the bundle). Nothing was sent.");
      if (["", ".", ".."].includes(run)) throw cli.fail(REFUSED, "RUN may not be empty, . or ..");
      // Ids only, checked here: a value pasted in their place is never sent, and never echoed.
      const restore = values.restore === undefined ? [] : values.restore.split(",").map((id) => id.trim()).filter(Boolean);
      if (values.restore !== undefined && (!restore.length || restore.some((id) => !CUT_ID.test(id)))) throw cli.fail(REFUSED, "--restore takes cut ids (c_ and 16 hex digits), comma-separated, as the page and the bundle's cuts name them.");
      const expect = values.expect?.toLowerCase();
      if (expect !== undefined && !SHA256.test(expect)) throw cli.fail(REFUSED, "--expect takes a sha256: 64 hex digits, as the page shows it.");
      const out = values.out === undefined ? undefined : resolve(values.out);
      if (out !== undefined && existsSync(out)) throw cli.fail(REFUSED, `${out} already exists: --out writes a new file. Nothing was asked of the server.`);

      const target = cli.targetOf(values, env);
      const client = cli.clientOf(target, io);
      const refused = client.refused;
      client.refused = (response, bytes) => {
        const mapped = REFUSALS[response.status]?.(messageOf(bytes), run);
        if (!mapped) return refused(response, bytes);
        io.stderr.write(`${mapped[1]}\n`);
        return mapped[0];
      };
      const query = restore.length ? `?${new URLSearchParams({ restore: restore.join(",") })}` : "";
      const { bytes, code } = await cli.request(client, { method: "GET", path: `/runs/${encodeURIComponent(run)}/export${query}` });
      if (code !== undefined) return io.stderr.write(`${NOTHING}\n`), code;

      // The bundle is checked before anything of it is used: its format, and the sha256 it names over its own content.
      let bundle;
      try {
        bundle = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw cli.fail(1, `The server's answer is not JSON. ${NOTHING}`);
      }
      if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle) || bundle.format !== FORMAT || typeof bundle.sha256 !== "string") throw cli.fail(1, `The server's answer is not an ${FORMAT} bundle. ${NOTHING}`);
      const { sha256: named, ...content } = bundle;
      if (createHash("sha256").update(stable(content)).digest("hex") !== named) throw cli.fail(1, `The server's bundle does not hash to the sha256 it names. ${NOTHING}`);
      if (expect !== undefined && named !== expect) {
        throw cli.fail(1, `The bundle's sha256 is ${named}, not the expected ${expect}: the run's export changed since the page showed it (its learning, a restore chosen there). Open the page again (agentrun share ${run} --dry-run) and use the command it shows now. ${NOTHING}`);
      }

      const summary = summaryOf(run, bundle, bytes);
      const page = `${new URL(target.base).origin}/share/${encodeURIComponent(run)}`;
      if (out !== undefined) {
        try {
          writeFileSync(out, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error.code === "EEXIST") throw cli.fail(REFUSED, `${out} already exists: --out writes a new file. ${NOTHING}`);
          throw cli.fail(1, `Cannot write ${out} (${error.code ?? error.name}). ${NOTHING}`);
        }
      }
      const lines = linesOf(summary);
      if (out !== undefined) lines.push(`Wrote ${out}.`);
      let opened = false;
      if (values["dry-run"]) {
        opened = values.open !== false && canOpen(env, platform) && (await launch(platform === "darwin" ? "open" : "xdg-open", [page], env));
        lines.push(opened ? `Opened the share preview in your browser. Nothing was sent anywhere.\nIf no browser opened, open ${page}` : `The share preview: ${page}\nNothing was sent anywhere.`);
      }
      io.stderr.write(`${lines.join("\n")}\n`);
      client.print({ ...summary, page, out: out ?? null, opened });
      return 0;
    },
  };
}

/** `agentrun share` (cli.mjs LOCAL). */
export const SHARE = shareOf();
