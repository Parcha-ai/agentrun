// Node 22 prints an ExperimentalWarning when node:sqlite loads (Node 24 prints none). It isn't the server's to show:
// the server's stderr is its own lines, one per failure (a refused start is exactly one), and its runs' processes
// start with --no-warnings=ExperimentalWarning for the same reason. The CLI imports this before anything loads
// node:sqlite (after the secrets' read, which loads none).
// Every other warning prints as Node prints it.
const printers = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /\bSQLite\b/.test(warning.message)) return;
  for (const print of printers) print(warning);
});
