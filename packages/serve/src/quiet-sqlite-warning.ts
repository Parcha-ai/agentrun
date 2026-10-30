// Node prints an ExperimentalWarning when node:sqlite loads. It isn't the server's to show: the server's stderr is its own
// lines, one per failure (a refused start is exactly one), and its runs' processes start with
// --no-warnings=ExperimentalWarning for the same reason. The CLI imports this first, before anything loads node:sqlite.
// Every other warning prints as Node prints it.
const printers = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /\bSQLite\b/.test(warning.message)) return;
  for (const print of printers) print(warning);
});
