import { WORKFLOW_NODE_KINDS, type AuthorHostAddendum } from '@parcha/agentrun-dsl';

/** What this extension adds to the shared workflow language: its commands, tools and unavailable transports.
 *  The packaged skill is rendered with it, and `describe` returns it as `authoring.host`. */
export const PI_HOST_ADDENDUM: AuthorHostAddendum = Object.freeze({
  name: 'Pi extension',
  nodeKinds: WORKFLOW_NODE_KINDS.filter(kind => kind !== 'artifact'),
  rules: [
    'Call agentrun with action describe first, then inspect the complete workflow with its input, then run without a workflow argument.',
    'Use exactly the tools describe returns. Without host-configured tools these are the active read-only built-ins (read, grep, find, ls), and bash, edit and write exist only in a trusted run; a host that configures its tools offers only those, including in trusted runs. The search tool reads fictional demo sources only.',
    'Code nodes and mutating tools run only after the user issues /agentrun run --trusted for that run. Trusted execution is local and unsandboxed.',
    'A call uses via tool with a tool describe returns. Shell and executor calls and artifact delivery are unavailable.',
    'This extension supplies no SOP text: do not run a workflow with sopSection here; it needs an SDK host that supplies the authoritative SOP.',
    'Custom extension tools and outer permission hooks are not inherited, including in trusted runs.',
    'The workflow is session-local: /agentrun shows it, /agentrun run reruns its last input, /agentrun stop requests cancellation and /agentrun status reports setup. Escape does not reliably cancel a slash-started run. There is no save or load.',
    'The structural limits describe returns bound node count, map concurrency and parallel branches.',
  ],
});
