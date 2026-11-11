// A stdout or stderr its reader closed (a terminal piped to `head`, a launcher that went away) loses the lines written
// after it, never the process. Without this, a write to it fails with EPIPE, emitted as an 'error' on the stream with no
// listener, which ends the server or a runner at its next line, console or raw write alike. Any other error on them is
// still thrown. cli.ts calls it first, for every command.

/** Keeps this process alive when its stdout or stderr reader has gone: EPIPE on either is dropped. */
export function surviveClosedPipes(streams: readonly NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}
