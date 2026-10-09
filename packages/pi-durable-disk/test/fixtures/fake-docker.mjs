#!/usr/bin/env node
// A fake docker CLI for dockerHost's unit tests: `fake-docker.mjs STATE_FILE <docker args...>`. Containers live in the
// state file; every call is appended to its `calls` with the argv and the size and text of stdin (a tar from `docker cp -`
// is kept as base64). It knows what dockerHost uses: info, create, cp, start, inspect, ps, stop, kill, rm, pause, unpause.
// `state.fail[<verb>]` makes that verb fail once with the given stderr.
import { readFileSync, writeFileSync } from "node:fs";

const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));
state.containers ??= {};
state.calls ??= [];
state.daemon ??= "daemon-1";
const stdin = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", () => resolve(Buffer.alloc(0)));
});
state.calls.push({ argv: args, stdin: stdin.length ? stdin.toString("base64") : "" });

const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const out = (text) => process.stdout.write(text);
const fail = (message, code = 1) => {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const find = (ref) => Object.values(state.containers).find((c) => c.id === ref || c.name === ref || c.id.startsWith(ref));
const verb = args[0];
if (state.fail?.[verb]) {
  const message = state.fail[verb];
  delete state.fail[verb];
  fail(message);
}

switch (verb) {
  case "info":
    out(args.includes("{{json .SecurityOptions}}") ? `${JSON.stringify(state.securityOptions ?? ["name=seccomp,profile=builtin"])}\n` : `${state.daemon}\n`);
    break;
  case "create": {
    const labels = {};
    const env = [];
    let name = "";
    let i = 1;
    const valued = new Set(["--name", "--hostname", "--label", "--device", "--cap-add", "--security-opt", "--restart", "--stop-timeout", "--env", "--mount", "--add-host", "--network"]);
    const flags = [];
    for (; i < args.length && args[i].startsWith("--"); i++) {
      const flag = args[i];
      if (!valued.has(flag)) fail(`fake docker: unknown create flag ${flag}`);
      const value = args[++i];
      flags.push([flag, value]);
      if (flag === "--name") name = value;
      if (flag === "--label") labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
      if (flag === "--env") env.push(value);
    }
    const image = args[i];
    const cmd = args.slice(i + 1);
    if (Object.values(state.containers).some((c) => c.name === name)) fail(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "x".`);
    state.next = (state.next ?? 0) + 1;
    const id = state.next.toString(16).padStart(12, "0") + "abcdef";
    state.containers[id] = { id, name, image, cmd, labels, env, flags, files: {}, state: { Status: "created", ExitCode: 0, OOMKilled: false, Error: "", StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" } };
    out(`${id}\n`);
    break;
  }
  case "cp": {
    const [src, dest] = args.slice(1);
    if (src !== "-") fail("fake docker: cp only from stdin");
    const [ref, path] = dest.split(":");
    const c = find(ref);
    if (!c) fail(`Error response from daemon: No such container: ${ref}`);
    c.files[path] = stdin.toString("base64");
    break;
  }
  case "start": {
    const c = find(args[1]);
    if (!c) fail(`Error response from daemon: No such container: ${args[1]}`);
    c.state.Status = state.startAs?.status ?? "running";
    if (state.startAs?.exitCode !== undefined) c.state.ExitCode = state.startAs.exitCode;
    c.state.StartedAt = new Date().toISOString();
    out(`${args[1]}\n`);
    break;
  }
  case "inspect": {
    const ref = args.at(-1);
    const c = find(ref);
    if (!c) fail(`Error: No such container: ${ref}`);
    out(`${JSON.stringify(c.state)}\t${JSON.stringify(c.labels)}\n`);
    break;
  }
  case "ps": {
    const filters = [];
    let format = "";
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--filter") filters.push(args[++i]);
      else if (args[i] === "--format") format = args[++i];
    }
    for (const c of Object.values(state.containers)) {
      const keep = filters.every((f) => {
        const [k, v] = f.replace(/^label=/, "").split("=");
        return c.labels[k] === v;
      });
      if (!keep) continue;
      if (!format.includes("{{.ID}}")) fail("fake docker: ps needs the ID format");
      out(`${c.id}\t${c.state.Status}\t${c.labels["pda.attempt"] ?? ""}\n`);
    }
    break;
  }
  case "stop":
  case "kill": {
    const ref = args.at(-1);
    const c = find(ref);
    if (!c) fail(`Error response from daemon: No such container: ${ref}`);
    if (c.state.Status === "running" || c.state.Status === "paused") {
      c.state.Status = "exited";
      c.state.ExitCode = verb === "kill" ? 137 : (state.stopExit ?? 0);
      c.state.FinishedAt = new Date().toISOString();
    }
    out(`${ref}\n`);
    break;
  }
  case "pause":
  case "unpause": {
    const c = find(args[1]);
    if (!c) fail(`Error response from daemon: No such container: ${args[1]}`);
    c.state.Status = verb === "pause" ? "paused" : "running";
    break;
  }
  case "rm": {
    const ref = args.at(-1);
    const c = find(ref);
    if (!c) fail(`Error response from daemon: No such container: ${ref}`);
    if (state.sticky?.includes(c.name)) break;
    delete state.containers[c.id];
    out(`${ref}\n`);
    break;
  }
  default:
    fail(`fake docker: unknown verb ${verb}`);
}
save();
