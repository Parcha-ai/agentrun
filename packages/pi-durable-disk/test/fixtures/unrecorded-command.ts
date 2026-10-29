// An instance killed before its recorder's first walk: `node unrecorded-command.ts <commands dir> <pid file>` starts
// one command carrying the recorder's mark (in a process group of its own, as pi starts each), writes the command's pid
// to <pid file>, and SIGKILLs itself, all in one turn of the event loop, so no walk ever runs and no record is written.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { COMMANDS_MARK, CommandRecorder } from "../../src/commands.ts";

const [dir, pidFile] = process.argv.slice(2);
const recorder = new CommandRecorder(dir!);
recorder.started();
const command = spawn("sleep", ["600"], { detached: true, stdio: "ignore", env: { ...process.env, [COMMANDS_MARK]: recorder.token } });
writeFileSync(pidFile!, String(command.pid));
process.kill(process.pid, "SIGKILL");
