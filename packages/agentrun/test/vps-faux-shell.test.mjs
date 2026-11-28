import { strict as assert } from "node:assert";
import { test } from "node:test";

import reply from "./vps-faux-shell.mjs";

// The faux runtime's shape as the model sees it: a message is what it was given, a tool call is its name and arguments.
const faux = {
  message: (content, options) => ({ content, ...options }),
  toolCall: (name, args) => ({ name, args }),
};
const user = (content) => ({ role: "user", content });

// The computer's reach note as the server appends it to the person's message (computer-deps.ts computerReachNote),
// right after the last line, with an apostrophe in it.
const REACH = "<system-reminder>AgentRun server note: this sandbox reaches only these hosts on the internet, on ports 80 and 443: registry.npmjs.org. Anything else from it is refused. Don't retry what fails for that.</system-reminder>";
const COMMAND = `printf 'box-%s-%s\\n' "$(uname -s)" "$(test -S /var/run/docker.sock && echo socket || echo nosocket)"`;

test("the shell line is the person's command alone: a server note appended to the message is not part of it", () => {
  for (const content of [`shell: ${COMMAND}${REACH}`, `shell: ${COMMAND}\n\n${REACH}`, [{ type: "text", text: `shell: ${COMMAND}` }, { type: "text", text: REACH }]]) {
    const asked = reply({ messages: [user(content)] }, faux);
    assert.deepEqual(asked.content, { name: "bash", args: { command: COMMAND } });
    assert.equal(asked.stopReason, "toolUse");
  }
});

test("a message with no shell line, or only a note, is answered without a call", () => {
  assert.equal(reply({ messages: [user("hello")] }, faux).content, "This model answers only the --vps walk's run.");
  assert.equal(reply({ messages: [user(`${REACH}`)] }, faux).content, "This model answers only the --vps walk's run.");
});

test("after the call it answers with what the call printed", () => {
  const done = reply({ messages: [user(`shell: ${COMMAND}${REACH}`), { role: "toolResult", content: "box-Linux-socket\n" }] }, faux);
  assert.equal(done.content, "The command printed: box-Linux-socket");
});
