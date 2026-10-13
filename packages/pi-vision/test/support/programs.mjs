// The programs a read starts, as the sweep sees them: stand-ins first on this process's PATH, each appending the
// environment it was started with to a file of its own and exiting. A read that starts one leaves its environment there;
// the sweep scans it for what the process was holding when it started.
import fs from "node:fs";
import path from "node:path";

export const PROGRAMS = ["pdftotext", "pdfinfo", "pdftoppm", "ffmpeg", "ffprobe", "soffice"];

/** Run `body` with `planted` (names to values) in this process's environment and the stand-in programs first on its
 *  PATH; restore both when it ends. Resolves to what each program that ran was started with, by program. `dir` is a
 *  directory of the sweep's own. */
export async function withPrograms(dir, planted, body) {
  const bin = fs.mkdtempSync(path.join(dir, "programs-"));
  const dump = (program) => path.join(bin, `${program}.env`);
  for (const program of PROGRAMS) {
    const file = path.join(bin, program);
    fs.writeFileSync(file, `#!/bin/sh\nenv >> '${dump(program)}'\nexit 0\n`);
    fs.chmodSync(file, 0o755);
  }
  const before = Object.fromEntries(["PATH", ...Object.keys(planted)].map((name) => [name, process.env[name]]));
  Object.assign(process.env, planted, { PATH: `${bin}${path.delimiter}${before.PATH}` });
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  return Object.fromEntries(PROGRAMS.filter((program) => fs.existsSync(dump(program))).map((program) => [program, fs.readFileSync(dump(program), "utf8")]));
}
