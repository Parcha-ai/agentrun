// The host tools the kernel makes itself, by name. Written for AgentRun.
//
// Each holds its result under the host's bound (HOST_RESULT_MAX_CHARS): read_skill_file reads a file a part at a time,
// delegate cuts a child's answer past its cap and says so, and submit cuts the errors it lists. test/host-bounds.test.mjs
// makes each one's largest result and fails on a host tool the kernel's source makes that is not named here.
import { DELEGATE_TOOL } from "./delegate.js";
import { SUBMIT_TOOL } from "./runner.js";
import { READ_SKILL_FILE } from "./skill-files.js";

export const KERNEL_HOST_TOOLS: readonly string[] = Object.freeze([SUBMIT_TOOL, DELEGATE_TOOL, READ_SKILL_FILE]);
