// The environment of a helper program the server starts itself (pdf_pages' pdfinfo, pdftoppm, pdftotext and ffmpeg): PATH
// to be found, the locale and the temp directory, and nothing else. The server's own environment holds secrets (model and
// tool keys, its token), and a helper parsing a hostile document must not hold them: any process of the same user can read
// a process's environment from /proc/<pid>/environ.

/** The names a helper program gets, from the server's environment, when they are set. */
export const HELPER_ENV_NAMES = ["PATH", "LANG", "LC_ALL", "TMPDIR"] as const;

/** A helper program's environment: HELPER_ENV_NAMES from `from` (the server's own by default), nothing else. */
export function helperEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of HELPER_ENV_NAMES) if (from[name] !== undefined) env[name] = from[name];
  return env;
}
