#!/usr/bin/env node
// Node prints an ExperimentalWarning the first time node:sqlite loads. A command line that prints one line (the address) is
// not the place for it, so that one warning is dropped before the server, which loads node:sqlite, is imported.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const [first] = rest;
  const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type ?? (warning as Error).name;
  if (type === "ExperimentalWarning" && String(typeof warning === "string" ? warning : warning.message).includes("SQLite")) return;
  return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./command.js");
process.exitCode = await main(process.argv.slice(2));
