// The harness conformance suite over claude-agent THROUGH the runner: the Claude Agent adapter on the kernel's adapter
// loop, its calls through the host's gate in its tool bridge, its session on the run's journal, its record kept by the
// loop. Case 10 ("park on ask; resume on the command row") must pass here before the cutover is ready.
import { after, test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { claudeAgentSubject, closeOpenSessions } from "./conformance-claude-agent.mjs";

registerHarnessConformance(claudeAgentSubject, { test });
// The crash cases' frozen loops never close their sessions: their CLIs and proxies close here, so the file can exit.
after(closeOpenSessions);
