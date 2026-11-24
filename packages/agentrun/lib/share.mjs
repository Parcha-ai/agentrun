// `agentrun share RUN --dry-run`: what sharing a run would send, shown and sent nowhere. The run's share bundle (GET
// /runs/{run_id}/export: one agentrun.share/1 document, every string of it cut by the server's scrubber) is fetched from
// the server this CLI talks to, checked against the sha256 it names, summed up (its cuts by kind, how many a preview may
// restore, its sha256 and size, what it left out), and the server's preview page, <origin>/share/RUN, is opened in this
// machine's browser as `agentrun open` opens the console (or its link printed where none opens). On the server
// `agentrun start` started with no accounts, the opener alone gets the start's launch code with it, so the browser has the
// console session the page asks for. Nothing of the run's words is printed, nor the code: counts, kinds and the paths
// the bundle already cut, no more.
// `--out FILE` writes the bundle's bytes as the server sent them (0600, never over a file); `--restore` asks the server to
// keep restorable cuts in place (a stateless re-export); `--expect SHA` refuses a bundle whose sha256 is another, the
// guard the page's publish command carries.
// `--to URL` publishes: the bundle, exported again with those restores and checked against --expect before anything is
// sent, is posted byte for byte to the share host at URL (POST <URL>/r/v2/shares, agentrun-serve --share-host) with the
// token `agentrun login --share URL` kept for that address alone, and the share's URL (<URL>/r/<id>) printed. A host's
// refusal is said in this CLI's words, with its counts by rule, never its message or a value. `agentrun share delete
// URL` takes a share down with the same token; its page then answers 410. Without --to, --dry-run or --out, share exits
// 2 and sends nothing.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shareTargetOf } from "./login.mjs";
import { canOpen, launchOpener } from "./service.mjs";
import { shareBase } from "./target.mjs";

/** start.mjs START_LOG, named again here: start.mjs imports cli.mjs, which imports this module (share.test.mjs writes
 *  the start log at start.mjs's name, so the two can't part). */
const START_LOG = "start.log";

/** Exits: 0 shown, written or published; 1 the server failed the export, refused it as withheld, or sent a bundle that
 *  is not what it names (or not the one --expect names), or the share host refused the bundle; 2 bad usage, a run the
 *  server does not have or that has not ended, a restore it refuses, a bundle over its cap, an --out file that exists,
 *  or none of --to, --dry-run and --out; 3 the share host not reached; 4 no share login for the host, or its token
 *  refused. */
const REFUSED = 2;
const FORMAT = "agentrun.share/1";
const CUT_ID = /^c_[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NOTHING = "Nothing was written or opened.";
const UNSENT = "Nothing was sent.";
const UNSTORED = "Nothing was stored.";
/** A share's id on a share host (share-host.ts SHARE_ID): 128 random bits in base32. */
const SHARE_ID = /^[a-z2-7]{26}$/;
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

const SIGN_IN_HINT = "Open the console's link from `agentrun start` first if the page asks you to sign in.";

/** The launch code of the console's link `agentrun start` saved for the server in `data` (its start log, START_LOG: the
 *  server's output up to its "Open " line, `Open <origin>/?launch=<code>` on a server with no accounts), when that link is
 *  at `origin`, the target's; else undefined: no start log (or one that is not a private file of this user's), a link
 *  with no code (a server with accounts), or another server's. The code gives a browser the console's session the share
 *  page asks for; it goes only to the opener, as the start's own link does, and is never printed. */
function launchCodeOf(cli, data, origin) {
  let text;
  try {
    text = cli.privateFile(join(data, START_LOG));
  } catch {
    return undefined;
  }
  const word = text?.split("\n").map((line) => /^Open (\S+)/.exec(line.replace(/\r$/, ""))?.[1]).find((found) => found !== undefined && URL.canParse(found));
  if (word === undefined) return undefined;
  const url = new URL(word);
  const code = url.searchParams.get("launch");
  return url.origin === origin && code ? code : undefined;
}

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

/** A share host's answer's error object, or {}: read for its code and details alone, never its message. */
function hostErrorOf(bytes) {
  try {
    const error = JSON.parse(bytes.toString("utf8"))?.error;
    return error !== null && typeof error === "object" && !Array.isArray(error) ? error : {};
  } catch {
    return {};
  }
}
const detailsOf = (error) => (error.details !== null && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {});
/** An error's code when it is one (lowercase letters and _), else undefined. */
const codeOf = (error) => (typeof error.code === "string" && /^[a-z_]{1,40}$/.test(error.code) ? error.code : undefined);
const whole = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : undefined);

/** The rule names a share host's counts are printed with: those the bundle's own records name (its cuts' and restores',
 *  the scrubber's ids as the server that cut it knows them). Any other name in a host's answer is counted as unknown: a
 *  name is printed only when this side knew it already, so no answer of a host's prints a value. */
const rulesOf = (bundle) => new Set([...(Array.isArray(bundle.cuts) ? bundle.cuts : []), ...(Array.isArray(bundle.restored) ? bundle.restored : [])].map((record) => record?.rule).filter((rule) => typeof rule === "string"));

/** Counts by rule from a host's answer, `rule n, ...`, in its order with unknown last; undefined when it holds none. */
function countsLine(value, known) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const counts = new Map();
  let unknown = 0;
  for (const [rule, n] of Object.entries(value)) {
    if (!whole(n)) continue;
    if (known.has(rule)) counts.set(rule, (counts.get(rule) ?? 0) + n);
    else unknown += n;
  }
  if (unknown) counts.set("unknown", unknown);
  return counts.size ? [...counts].map(([rule, n]) => `${rule} ${n}`).join(", ") : undefined;
}

/** What a 422 from a share host says, by its reason. */
const SCREENED = {
  scrub_found: "its scrub found values no restore declares",
  restored_unmatched: "restored records of it name values its scrub does not find there (a stale bundle, or a scrubber of another version)",
  scrub_failed: "its scrub of it failed, and the scrub fails closed",
};

/** A share host's refusal of an upload: its exit, and this CLI's words, with counts and numbers from its details and its
 *  code alone, never its message or a value of it. */
function uploadRefusal(response, bytes, { host, known, run }) {
  const error = hostErrorOf(bytes);
  const details = detailsOf(error);
  const code = codeOf(error);
  const login = `agentrun login --share ${host} < TOKEN_FILE`;
  switch (response.status) {
    case 401:
      return [4, `The share host at ${host} refused the token (401). Sign in to it again: ${login}. ${UNSTORED}`];
    case 403: {
      if (details.reason !== "share_quota") return [4, `The share host at ${host} refused the token (403${code ? ` ${code}` : ""}). Sign in to it again: ${login}. ${UNSTORED}`];
      const [used, limit] = [whole(details.used), whole(details.limit)];
      return [1, `The share host at ${host}: this token keeps ${used ?? "its most"} shares${limit === undefined ? "" : `, its most (${limit})`}. Take one down to make room: agentrun share delete URL. ${UNSTORED}`];
    }
    case 422: {
      const reason = Object.hasOwn(SCREENED, details.reason) ? details.reason : undefined;
      const found = countsLine(details.counts, known);
      const unmatched = countsLine(details.unmatched, known);
      const said = [reason ? SCREENED[reason] : "it refused what the bundle holds", ...(found ? [`by rule: ${found}`] : [])].join(", ");
      const page = `agentrun share ${run} --dry-run`;
      const advice = reason === "scrub_found" ? ` A restore keeps a label, personal or jev cut, never a key format, a held value or a dump: open the page again (${page}) and publish with those cuts in place.` : reason === "restored_unmatched" ? ` Open the page again (${page}) and use the command it shows now.` : "";
      return [1, `The share host refused the bundle (422 ${reason ?? code ?? "input_invalid"}): ${said}${unmatched ? `; restored records it could not match, by rule: ${unmatched}` : ""}.${advice} Its answer is not shown. ${UNSTORED}`];
    }
    case 400:
      return [1, `The share host refused the bundle (400): it does not take this bundle's format or shape (an AgentRun of another version on one side). Its answer is not shown. ${UNSTORED}`];
    case 413: {
      const [strings, limit] = [whole(details.strings), whole(details.limit)];
      if (details.reason === "share_strings" && strings !== undefined && limit !== undefined) return [1, `The share host refused the bundle (413): it holds ${strings} distinct strings, over the ${limit} the host scrubs one by one. ${UNSTORED}`];
      return [1, `The share host refused the bundle (413): it is over the host's size cap. ${UNSTORED}`];
    }
    case 404:
      return [1, `${host} answered 404 at /r/v2/shares: no share host there. --to takes a share host's address, such as https://agentrun.ai. ${UNSTORED}`];
    default:
      return [response.status === 501 ? 5 : 1, `The share host refused it: ${response.status}${code ? ` ${code}` : ""}. Its answer is not shown. ${UNSTORED}`];
  }
}

/** A client of the share host's API at `target` (login.mjs shareTargetOf), its refusals said by `refusal`. */
function hostClientOf(cli, io, host, target, refusal) {
  const client = cli.clientOf(target, io);
  client.unreachable = (error) => cli.fail(3, `Cannot reach the share host at ${host} (${error?.cause?.code ?? error?.name}).`);
  client.refused = (response, bytes) => {
    const [exit, said] = refusal(response, bytes);
    if (said) io.stderr.write(`${said}\n`);
    return exit;
  };
  return client;
}

/** `share RUN --to`: the checked bundle's bytes posted to the share host, and the share's URL printed. */
async function publishTo(cli, io, { host, target, bytes, bundle, summary }) {
  const known = rulesOf(bundle);
  const client = hostClientOf(cli, io, host, target, (response, body) => uploadRefusal(response, body, { host, known, run: summary.run }));
  const got = await cli.request(client, { method: "POST", path: "/shares", headers: {}, body: bytes, type: "application/json" });
  if (got.code !== undefined) return got.code;
  let answer;
  try {
    answer = JSON.parse(got.bytes.toString("utf8"));
  } catch {
    answer = undefined;
  }
  if (typeof answer?.id !== "string" || !SHARE_ID.test(answer.id)) {
    io.stderr.write(`The share host at ${host} answered ${got.response.status} with no share id; whether it stored the bundle is unknown.\n`);
    return 1;
  }
  const { id } = answer;
  // The host's URL for it (on its public address), when it is one for this id; else the one its layout makes.
  const url = typeof answer.url === "string" && /^https?:\/\//.test(answer.url) && URL.canParse(answer.url) && new URL(answer.url).pathname.endsWith(`/r/${id}`) && !/[?#]/.test(answer.url) ? answer.url : `${host}/r/${id}`;
  const lines = linesOf(summary);
  lines.push(`Shared: ${url}`, `Anyone with the link can open it. Take it down with: agentrun share delete ${url}`);
  const unchecked = countsLine(answer.restored_unchecked, known);
  if (unchecked) lines.push(`Restores of Jev's cuts the host took unchecked (it runs no Jev), by rule: ${unchecked}.`);
  if (answer.sha256 !== summary.sha256) {
    lines.push(`The share host names another sha256 for it than the ${summary.sha256} sent: take it down (agentrun share delete ${url}) and ask the host's operator.`);
    io.stderr.write(`${lines.join("\n")}\n`);
    client.print({ ...summary, url, id });
    return 1;
  }
  io.stderr.write(`${lines.join("\n")}\n`);
  client.print({ ...summary, url, id });
  return 0;
}

/** A share's URL, `<host>/r/<id>`: its host's address (target.mjs shareBase) and its id; undefined for any other. */
function shareUrlOf(given) {
  const url = typeof given === "string" && URL.canParse(given) ? new URL(given) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(given) || url.username || url.password) return undefined;
  const found = /^(.*)\/r\/([a-z2-7]{26})\/?$/.exec(url.pathname);
  const host = found && shareBase(`${url.origin}${found[1]}`);
  return host ? { host, id: found[2] } : undefined;
}

/** `agentrun share delete URL` (cli.mjs LOCAL): a share taken down, with the share host's login. */
export const SHARE_DELETE = {
  command: ["share", "delete"],
  pathParams: ["url"],
  route: "DELETE <host>/r/v2/shares/{id}, on the share host the URL is on",
  summary: "Take a published share down with the share host's login: its page and bundle then answer 410",
  help: [["URL", "the share's URL, as share --to printed it: <share host>/r/<id>"]],
  options: {},
  async run({ args, env, io, cli }) {
    const parsed = shareUrlOf(args[0]);
    if (!parsed) throw cli.fail(REFUSED, "agentrun share delete takes a share's URL, as agentrun share --to printed it: <share host>/r/<id> (http or https, with no query, fragment, user or password).");
    const { host, id } = parsed;
    const url = `${host}/r/${id}`;
    const UNDELETED = "Nothing was deleted.";
    const target = shareTargetOf(host, env, cli, UNDELETED);
    let already = false;
    const client = hostClientOf(cli, io, host, target, (response, bytes) => {
      const code = codeOf(hostErrorOf(bytes));
      switch (response.status) {
        case 410:
          already = true;
          return [0];
        case 404:
          return [1, `The share host at ${host} has no share ${id}. ${UNDELETED}`];
        case 403:
          return [4, `The share ${id} was made with another token; only that token deletes it. ${UNDELETED}`];
        case 401:
          return [4, `The share host at ${host} refused the token (401). Sign in to it again: agentrun login --share ${host} < TOKEN_FILE. ${UNDELETED}`];
        default:
          return [response.status === 501 ? 5 : 1, `The share host refused it: ${response.status}${code ? ` ${code}` : ""}. Its answer is not shown. ${UNDELETED}`];
      }
    });
    const got = await cli.request(client, { method: "DELETE", path: `/shares/${id}`, headers: {} });
    if (got.code !== undefined && !already) return got.code;
    io.stderr.write(already ? `${url} was already deleted: its page answers 410 Gone.\n` : `Deleted ${url}: its page now answers 410 Gone.\n`);
    client.print({ url, id, deleted: true });
    return 0;
  },
};

/** The command, given what opens a browser here; SHARE (below) binds it to this machine. */
export function shareOf({ launch = launchOpener, platform = process.platform } = {}) {
  return {
    command: ["share"],
    pathParams: ["run"],
    route: "GET /runs/{run_id}/export; with --to, then POST <host>/r/v2/shares on the share host; the page --dry-run opens is <origin>/share/{run_id}",
    summary: "Share an ended run: publish its bundle to a share host (--to), or show what that would send (--dry-run: its bundle checked and summed up, its page opened here) or write it (--out)",
    help: [
      ["RUN", "the run's id: an ended run"],
      ["--to URL", "publish: the bundle, exported again with --restore and checked against --expect before anything is sent, posted to the share host at URL with the token agentrun login --share URL kept; prints the share's URL"],
      ["--dry-run", "fetch the run's share bundle, print its summary and open its preview page; nothing is sent anywhere"],
      ["--out FILE", "write the bundle as the server sent it, byte for byte (0600, never over a file); alone, it opens nothing"],
      ["--restore IDS", "cut ids to keep in place, comma-separated (restorable ones only: a label, personal or jev cut)"],
      ["--expect SHA", "refuse a bundle whose sha256 is another (the page's publish command carries it)"],
      ["--no-open", "open no browser; print the page's link"],
    ],
    options: { "dry-run": { type: "boolean" }, out: { type: "string" }, to: { type: "string" }, restore: { type: "string" }, expect: { type: "string" }, open: { type: "boolean" } },
    async run({ values, args, env, io, cli }) {
      const [run] = args;
      const publish = values.to !== undefined;
      if (!publish && !values["dry-run"] && values.out === undefined) throw cli.fail(REFUSED, `agentrun share RUN takes --to URL (publish it to a share host), --dry-run (preview its page) or --out FILE (write its bundle). ${UNSENT}`);
      if (publish && (values["dry-run"] || values.out !== undefined)) throw cli.fail(REFUSED, `--to publishes the bundle; --dry-run and --out show or write it: one at a time. ${UNSENT}`);
      if (["", ".", ".."].includes(run)) throw cli.fail(REFUSED, "RUN may not be empty, . or ..");
      // Ids only, checked here: a value pasted in their place is never sent, and never echoed.
      const restore = values.restore === undefined ? [] : values.restore.split(",").map((id) => id.trim()).filter(Boolean);
      if (values.restore !== undefined && (!restore.length || restore.some((id) => !CUT_ID.test(id)))) throw cli.fail(REFUSED, "--restore takes cut ids (c_ and 16 hex digits), comma-separated, as the page and the bundle's cuts name them.");
      const expect = values.expect?.toLowerCase();
      if (expect !== undefined && !SHA256.test(expect)) throw cli.fail(REFUSED, "--expect takes a sha256: 64 hex digits, as the page shows it.");
      const out = values.out === undefined ? undefined : resolve(values.out);
      if (out !== undefined && existsSync(out)) throw cli.fail(REFUSED, `${out} already exists: --out writes a new file. Nothing was asked of the server.`);
      // The share host and its login before the export: a publish that can't be sent asks nothing of the server.
      const host = publish ? shareBase(values.to) : undefined;
      if (publish && host === undefined) throw cli.fail(REFUSED, `--to must be a share host's http or https address with no query, fragment, user or password (https://agentrun.ai, or a self-hosted agentrun-serve --share-host). ${UNSENT}`);
      const hostTarget = publish ? shareTargetOf(host, env, cli, UNSENT) : undefined;
      const nothing = publish ? UNSENT : NOTHING;

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
      if (code !== undefined) return io.stderr.write(`${nothing}\n`), code;

      // The bundle is checked before anything of it is used: its format, and the sha256 it names over its own content.
      let bundle;
      try {
        bundle = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw cli.fail(1, `The server's answer is not JSON. ${nothing}`);
      }
      if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle) || bundle.format !== FORMAT || typeof bundle.sha256 !== "string") throw cli.fail(1, `The server's answer is not an ${FORMAT} bundle. ${nothing}`);
      const { sha256: named, ...content } = bundle;
      if (createHash("sha256").update(stable(content)).digest("hex") !== named) throw cli.fail(1, `The server's bundle does not hash to the sha256 it names. ${nothing}`);
      if (expect !== undefined && named !== expect) {
        throw cli.fail(1, `The bundle's sha256 is ${named}, not the expected ${expect}: the run's export changed since the page showed it (its learning, a restore chosen there). Open the page again (agentrun share ${run} --dry-run) and use the command it shows now. ${nothing}`);
      }

      const summary = summaryOf(run, bundle, bytes);
      if (publish) return publishTo(cli, io, { host, target: hostTarget, bytes, bundle, summary });
      const origin = new URL(target.base).origin;
      const page = `${origin}/share/${encodeURIComponent(run)}`;
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
        // On the server `agentrun start` started with no accounts, the browser opens the page with the start's launch
        // code, which signs it in to the console as the start's link does; the link printed never carries it.
        const code = launchCodeOf(cli, resolve(values.data ?? join(homedir(), ".agentrun")), origin);
        const link = code === undefined ? page : `${page}?${new URLSearchParams({ launch: code })}`;
        opened = values.open !== false && canOpen(env, platform) && (await launch(platform === "darwin" ? "open" : "xdg-open", [link], env));
        lines.push(opened ? `Opened the share preview in your browser. Nothing was sent anywhere.\nIf no browser opened, open ${page}` : `The share preview: ${page}\nNothing was sent anywhere.`);
        if (code !== undefined) lines.push(SIGN_IN_HINT);
      }
      io.stderr.write(`${lines.join("\n")}\n`);
      client.print({ ...summary, page, out: out ?? null, opened });
      return 0;
    },
  };
}

/** `agentrun share` (cli.mjs LOCAL). */
export const SHARE = shareOf();
