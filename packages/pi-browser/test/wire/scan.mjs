// The scanner: every byte a run produced is searched for every sentinel in every encoding a leak takes. A finding
// names the sentinel, the form it took and the exact location (file and offset, table row and column, JSON path).
//
// Coverage is part of the result: a scan of an empty directory is green and proves nothing, so each source reports
// how many bytes and records it covered and the test asserts a floor.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const FRAGMENT = 16; // a leak of the head or tail of a value is a leak; shorter fragments would false-match

/** Every needle a sentinel can appear as. */
export function needlesOf(name, value) {
  const out = [];
  const add = (form, needle) => { if (needle && needle.length >= FRAGMENT && !out.some((n) => n.needle === needle)) out.push({ name, form, needle }); };
  add("raw", value);
  add("url-encoded", encodeURIComponent(value));
  add("json-escaped", JSON.stringify(value).slice(1, -1));
  add("hex", Buffer.from(value, "utf8").toString("hex"));
  // base64 and base64url at all three byte alignments: strip the characters the alignment makes unstable.
  for (const k of [0, 1, 2]) {
    const lead = [0, 2, 3][k];
    for (const enc of ["base64", "base64url"]) {
      const full = Buffer.from("x".repeat(k) + value, "utf8").toString(enc).replace(/=+$/, "");
      add(`${enc}+${k}`, full.slice(lead, full.length - 3));
    }
  }
  if (/^[A-Z2-7]+$/.test(value)) {
    // a TOTP seed as a human or a QR page writes it: lowercase, in groups
    add("lowercase", value.toLowerCase());
    add("grouped-space", value.match(/.{1,4}/g).join(" "));
    add("grouped-dash", value.match(/.{1,4}/g).join("-"));
  }
  // a URL's head is its scheme and host, which is no secret; its secret parts are sentinels of their own
  if (value.length >= FRAGMENT * 2 && !value.includes("://")) {
    add("fragment-head", value.slice(0, FRAGMENT));
    add("fragment-tail", value.slice(-FRAGMENT));
  }
  return out;
}

export class Scan {
  /** `allow` names the sources a sentinel may appear in by design: `{ bbLiveViewUrl: ["onSession"] }` (the host channel). */
  constructor(sentinels, { allow = {} } = {}) {
    this.allow = allow;
    this.needles = Object.entries(sentinels).flatMap(([name, value]) => needlesOf(name, value));
    this.findings = [];
    this.coverage = [];
  }

  cover(source, bytes, records = 1) {
    const row = this.coverage.find((c) => c.source === source);
    if (row) { row.bytes += bytes; row.records += records; } else this.coverage.push({ source, bytes, records });
  }

  #hit(needle, source, where) {
    if ((this.allow[needle.name] ?? []).some((prefix) => source.startsWith(prefix))) return;
    // one finding per (sentinel, source, where): the first form that matched, so the report stays readable
    if (this.findings.some((f) => f.sentinel === needle.name && f.source === source && f.where === where)) return;
    this.findings.push({ sentinel: needle.name, form: needle.form, source, where });
  }

  /** A string with a place name: `where` is a JSON path, a column, a file offset. */
  text(source, where, text) {
    if (typeof text !== "string" || text.length === 0) return;
    for (const n of this.needles) {
      const at = text.indexOf(n.needle);
      if (at >= 0) this.#hit(n, source, `${where}@${at}`);
    }
  }

  bytes(source, where, buf) {
    for (const n of this.needles) {
      const at = buf.indexOf(n.needle);
      if (at >= 0) this.#hit(n, source, `${where}@${at}`);
    }
  }

  /** Keys and values of any JSON-shaped value; a string that is itself JSON is searched decoded too. */
  json(source, value, where = "$") {
    this.cover(source, 0, 1);
    const walk = (v, p, depth) => {
      if (typeof v === "string") {
        this.text(source, p, v);
        if (depth < 4 && (v.startsWith("{") || v.startsWith("["))) { try { walk(JSON.parse(v), `${p}~json`, depth + 1); } catch { /* not JSON */ } }
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`, depth));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { this.text(source, `${p}.<key>`, k); walk(x, `${p}.${k}`, depth); }
      else if (typeof v === "number" || typeof v === "boolean") this.text(source, p, String(v));
    };
    walk(value, where, 0);
  }

  /** A directory tree: file names and every file's bytes. */
  dir(source, root) {
    if (!fs.existsSync(root)) { this.cover(source, 0, 0); return; }
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);
        this.text(source, `name:${rel}`, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) { const buf = fs.readFileSync(full); this.cover(source, buf.length); this.bytes(source, rel, buf); }
      }
    };
    visit(root);
  }

  /**
   * A run.sqlite: the raw bytes of the file and its WAL (a deleted row still sits in free pages), then every cell of
   * every table, JSON cells decoded, so the finding names `table[rowid].column.json.path`.
   */
  sqlite(source, file) {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      if (!fs.existsSync(f)) continue;
      const buf = fs.readFileSync(f);
      this.cover(`${source}:raw`, buf.length);
      this.bytes(`${source}:raw`, path.basename(f), buf);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all().map((r) => r.name);
      for (const table of tables) {
        for (const row of db.prepare(`select rowid as __rowid, * from "${table}"`).all()) {
          this.cover(`${source}:${table}`, 0, 1);
          for (const [column, cell] of Object.entries(row)) {
            if (column === "__rowid") continue;
            const where = `${table}[${row.__rowid}].${column}`;
            if (typeof cell === "string") {
              this.text(`${source}:${table}`, where, cell);
              if (cell.startsWith("{") || cell.startsWith("[")) { try { this.json(`${source}:${table}`, JSON.parse(cell), where); } catch { /* not JSON */ } }
            } else if (cell instanceof Uint8Array) this.bytes(`${source}:${table}`, where, Buffer.from(cell));
            else if (cell !== null && cell !== undefined) this.text(`${source}:${table}`, where, String(cell));
          }
        }
      }
    } finally { db.close(); }
  }

  clean() { return this.findings.length === 0; }

  report() {
    if (this.clean()) return "no sentinel found";
    return this.findings.map((f) => `${f.sentinel} (${f.form}) in ${f.source} at ${f.where}`).join("\n");
  }

  coverageOf(prefix) {
    return this.coverage.filter((c) => c.source.startsWith(prefix)).reduce((a, c) => ({ bytes: a.bytes + c.bytes, records: a.records + c.records }), { bytes: 0, records: 0 });
  }
}

/**
 * The scanner against itself, with encodings computed a second, independent way: the value is wrapped in surrounding
 * bytes at every base64 alignment, URL-encoded, JSON-escaped, hex-encoded and (for a seed) grouped, and each wrapped
 * string must be found. A scanner that quietly stopped matching a form would turn every leak green.
 */
export function proveScannerSees(sentinels) {
  const missed = [];
  let forms = 0;
  for (const [name, value] of Object.entries(sentinels)) {
    const planted = {
      raw: `a ${value} b`,
      "url-encoded": `?q=${encodeURIComponent(value)}&x=1`,
      json: JSON.stringify({ k: `p${value}s` }),
      hex: `00${Buffer.from(value).toString("hex")}ff`,
      ...(value.length >= FRAGMENT * 2 && !value.includes("://") ? { "fragment-head": value.slice(0, 24), "fragment-tail": value.slice(-24) } : {}),
      ...Object.fromEntries([0, 1, 2].flatMap((k) => ["base64", "base64url"].map((enc) => [`${enc}+${k}`, Buffer.from(`${"-".repeat(k)}${value}!!`).toString(enc)]))),
    };
    if (/^[A-Z2-7]+$/.test(value)) {
      planted.lower = value.toLowerCase();
      planted.grouped = value.match(/.{1,4}/g).join(" ");
    }
    for (const [form, text] of Object.entries(planted)) {
      forms += 1;
      const probe = new Scan({ [name]: value });
      probe.text("probe", form, text);
      if (!probe.findings.some((f) => f.sentinel === name)) missed.push(`${name} ${form}`);
    }
  }
  return { forms, missed };
}
