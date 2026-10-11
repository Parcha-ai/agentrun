// A faithful render of an office document: LibreOffice in the environment converts it to PDF with a private profile,
// and the PDF is read as one. The program runs through the environment's `exec`, so it runs where the agent's shell
// runs. LibreOffice inflates every entry of a document, so the archive is held to the zero-install reader's limits and
// then every entry is inflated once, checked and discarded, bounded by the size it declares: an archive that lies about
// a size or a checksum never reaches the program. Each conversion works in a directory of its own, named afresh, that
// holds the profile, the input and the output, and removes it when it ends: two conversions, of the same document too,
// never share a profile, and nothing is left behind but the PDF, which is named by the document's hash and put in place
// by a rename, so a reader of it sees a whole one.
import { randomUUID } from "node:crypto";
import { visionContext, type VisionResult } from "../core/env.js";
import { OFFICE_LIMITS, OfficeMissError, inflateEntry, readSource, zipDirectory, type OfficeLimits } from "../core/office.js";
import { detectOnce, type Detection, type Provider } from "../core/provider.js";

/** A version probe is cut after this many seconds (2026-10-11). */
const DETECT_TIMEOUT_S = 30;
/** A conversion is cut after this many seconds; provisional: a cold LibreOffice start takes seconds and a long document tens of seconds (2026-10-11, not measured on this build box, which has no LibreOffice). */
const CONVERT_TIMEOUT_S = 180;
const NEEDS = "LibreOffice (soffice) in the environment";

export type SofficeOptions = {
  /** The program to run; default `soffice`. */
  readonly command?: string;
  readonly timeoutS?: number;
  readonly limits?: Partial<OfficeLimits>;
};

const step = <T>(result: VisionResult<T, Error>, what: string): T => {
  if (!result.ok) throw new OfficeMissError("unreadable", `${what}: ${result.error.message.split("\n")[0]}`);
  return result.value;
};

export function sofficeProvider(options: SofficeOptions = {}): Provider {
  const command = options.command ?? "soffice";
  const timeout = options.timeoutS ?? CONVERT_TIMEOUT_S;
  const limits: OfficeLimits = { ...OFFICE_LIMITS, ...options.limits };
  const provider: Provider = {
    name: "soffice",
    capabilities: ["office"],
    kinds: ["office", "sheet"],
    async detect(env, signal) {
      const missing = (reason: string): Detection => ({ available: false, needs: NEEDS, reason });
      const context = visionContext(signal);
      try {
        const dir = await env.createTempDir("pi-vision-soffice-", context);
        if (!dir.ok) return missing(`no temporary directory: ${dir.error.message.split("\n")[0]}`);
        try {
          const printed = `${dir.value}/version.txt`;
          const ran = await env.exec(["sh", "-c", 'exec "$0" --version >"$1" 2>&1', command, printed], { timeout: DETECT_TIMEOUT_S }, context);
          if (!ran.ok) return missing(ran.error.message.split("\n")[0]);
          if (ran.value.exitCode !== 0) return missing(`${command} --version exited ${ran.value.exitCode}`);
          const read = await env.readBinaryFile(printed, context);
          const version = read.ok ? new TextDecoder().decode(read.value).split("\n")[0]!.trim() : "";
          return version ? { available: true, version } : missing(`${command} --version printed nothing`);
        } finally {
          await env.remove(dir.value, { recursive: true, force: true }, visionContext());
        }
      } catch (error) {
        return missing(String((error as Error)?.message ?? error).split("\n")[0]!);
      }
    },
    async office(source, _request, call) {
      const found = await detectOnce(provider, call.env);
      if (!found.available) throw new OfficeMissError("needs", `${found.needs}: ${found.reason}`);
      const bytes = await readSource(source, call);
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) for (const entry of zipDirectory(bytes, limits)) {
        await inflateEntry(bytes, entry, entry.originalSize, false);
        await new Promise((done) => setImmediate(done));
      }
      const { env } = call;
      const context = visionContext(call.signal);
      const stem = source.sha256.slice(0, 16);
      const work = `${call.tempDir}/soffice-${stem}-${randomUUID().slice(0, 8)}`;
      const input = `${work}/in/${stem}${/\.[a-z0-9]{1,5}$/i.exec(source.path)?.[0].toLowerCase() ?? ""}`;
      const produced = `${work}/out/${stem}.pdf`;
      const final = `${call.tempDir}/soffice-${source.sha256}.pdf`;
      try {
        for (const dir of ["in", "out", "profile"]) step(await env.createDir(`${work}/${dir}`, { recursive: true }, context), "the working directory could not be made");
        step(await env.writeFile(input, bytes, context), "the document could not be copied for LibreOffice");
        const ran = await env.exec([command, "--headless", "--invisible", "--norestore", "--nolockcheck", "--nodefault", "--nologo", `-env:UserInstallation=file://${`${work}/profile`.split("/").map(encodeURIComponent).join("/")}`, "--convert-to", "pdf", "--outdir", `${work}/out`, input], { timeout }, context);
        if (!ran.ok) {
          if (ran.error.code === "aborted") throw ran.error;
          throw new OfficeMissError(ran.error.code === "timeout" ? "over_budget" : "needs", ran.error.code === "timeout" ? `LibreOffice did not finish within ${timeout} s; read the document's text instead` : `${NEEDS}: ${ran.error.message.split("\n")[0]}`);
        }
        const made = await env.fileInfo(produced, context);
        if (ran.value.exitCode !== 0 || !made.ok || made.value.size === 0) throw new OfficeMissError("unreadable", `LibreOffice could not convert it to a PDF (exit ${ran.value.exitCode})`);
        step(await env.renameFile(produced, final, context), "the PDF could not be kept");
        return { madeBy: { provider: "soffice", version: found.version }, path: final };
      } finally {
        await env.remove(work, { recursive: true, force: true }, visionContext());
      }
    },
  };
  return provider;
}
