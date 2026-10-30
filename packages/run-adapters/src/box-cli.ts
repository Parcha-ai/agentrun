#!/usr/bin/env node
// agentrun-box: the box's operator commands. Written for AgentRun.
//   agentrun-box install   as root, once, on the host that runs serve: the AppArmor profile bwrap needs (see box-install)
import { argv, exit, stderr, stdout } from "node:process";
import { BoxInstallError, installBox } from "./host/box-install.js";

const [command, ...rest] = argv.slice(2);
if (command !== "install" || rest.length > 0) {
  stderr.write("usage: agentrun-box install\n");
  exit(2);
}
try {
  const result = installBox();
  if (result.status === "not_needed") stdout.write(`agentrun-box: nothing to install: ${result.detail}\n`);
  else
    stdout.write(
      `agentrun-box: ${result.written ? "wrote" : "kept"} ${result.profile} and loaded it. Every local user of this host can now make a user namespace through bwrap.\n`,
    );
} catch (error) {
  if (!(error instanceof BoxInstallError)) throw error;
  stderr.write(`agentrun-box: ${error.message}\n`);
  exit(1);
}
