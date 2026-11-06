# AgentRun console

The shared React administration console and typed `agentrun.v2/0` client. Mission Control, Agents, Runs and Settings use the native AgentRun Server. Building and running it requires no hosted account or private service. External coding-agent actions provide skill onboarding and task context through an editable, copyable prompt.

## Run from a public checkout

From the repository root, use the Node and npm versions in `CONTRIBUTING.md`:

```sh
npm ci --ignore-scripts
npm run build
node packages/serve/dist/cli.js --data ./local-agentrun-data --port 7340 \
  --faux packages/serve/test/fixtures/faux-model.mjs
```

Open the setup URL printed by the server. The console signs in through the server's HttpOnly session cookie; the setup code leaves the address. `AGENTRUN_ACCOUNTS=0` uses the server's local token bootstrap instead. Never paste a credential into an external coding-agent handoff or screenshot.

The standalone local owner's sign-out ends every owner browser session. Embedded applications supply their own sign-out behavior through the provider.

For UI development, run `npm ci --ignore-scripts` and `npm run dev` here. The dev server binds to loopback and proxies `/v2` to `AGENTRUN_URL` or the native server's default loopback port. `AGENTRUN_TOKEN` can authenticate that development proxy. The static production build uses only same-origin `/v2` requests.

## Embed the shared console

The package is versioned and held with `private: true`. Registry publication requires a reviewed release. `npm run build` emits the standalone page and `dist/library`, including declarations and CSS. An application that installs a reviewed local package archive can compose:

```tsx
import { AgentRunConsole, AgentRunProvider, createClient } from "@parcha/agentrun-ui";
import "@parcha/agentrun-ui/styles.css";

const client = createClient({ base: "/v2" });

<AgentRunProvider
  client={client}
  session={{ id: "local-owner", authenticated: true, kind: "local-owner" }}
>
  <AgentRunConsole />
</AgentRunProvider>;
```

The host supplies its own authenticated session, workspace and explicit optional extension routes. Change `session.id`, `session.generation` or the server identity when the identity or authority changes. A protected 401 invalidates the provider and removes its private children. The standalone `AgentRunApp` keeps local-owner setup/sign-in independent from a host's identity policy.

The embedding host must set a Content Security Policy and security headers before mounting the console. Use the native server policy as the baseline: scripts and connections from reviewed origins only, no inline scripts, images limited to the same origin and `data:`/`blob:`, no embedding by other origins, no referrers and `nosniff`. Sanitizing Markdown does not prevent external image requests; the host image policy also applies to model output. Serve the console on a dedicated hostname within one trust boundary.

React is external to the library bundle; use the React version declared by the package. The library has no Tailwind or shadcn runtime dependency. The standalone source uses a build-time utility stylesheet generator; consumers load the emitted CSS and need no utility framework configuration.

## Client and contract

`createClient()` uses a same-origin cookie. Server-side callers can explicitly choose `{ base: serverUrl + "/v2", auth: { type: "bearer", token } }`; that transport omits browser cookies. Keep that client outside browser bundles and never serialize the token. Errors retain the server's status, code, details, field issues, request ID and retryability. ETags and caller-owned idempotency keys are preserved; writes are never automatically retried.

`src/lib/contract.generated.ts` is generated from the native server's OpenAPI document. After building the native packages, run `npm run generate:contract`, or add `-- --check` to check for drift. The client exposes the contract fields consumed by the UI and optional native server extensions. A missing capability never authorizes an enterprise action.

Skill edits take a complete text-file bundle and require an explicit replacement confirmation. Omitting the bundle preserves the saved revision's skills. Native definitions, schemas and connection references remain native; no Grep definition import is performed.

Run timelines preserve cursor, reset, drop and final semantics. Reconnect resumes a retained cursor; a server reset replaces the displayed rows. Stop requests an interruption that can continue; Cancel requests termination. Acceptance of a command is displayed separately from the observed run state. Costs are local estimates or reported usage; unknown values stay unknown. Mission Control labels bounded activity separately from whole-store totals.

Imported histories accept no new messages. Completed archived runs must be unarchived before a follow-up; archiving an active run retains its native controls. Mission Control uses optional `result_available` and `files_available` summary fields, displaying absent or null facts as unknown. File availability uses a confined scan with a metadata-read/depth limit and reads no file content. Directory-name enumeration uses the native walker and is not bounded by that metadata budget.

File bytes are fetched through the authenticated client. Downloads preserve the original Blob. Markdown is sanitized, HTML previews are sandboxed, and scripts never run in an artifact preview. Incomplete listings and failed reads remain visible.

## Design tokens

`src/tokens.css` holds every colour, radius and theme custom property, light and dark. It is generated from a design-token vocabulary shared with other applications and vendored with that vocabulary in `design-tokens/vocabulary.json`; its header names the command that regenerates both. Never edit either file by hand: `src/tokens.test.ts` and `scripts/check-generated.mjs` fail when the stylesheet's recorded hashes do not match it and the vocabulary, when `src/styles.css` declares a token itself, or when a Tailwind colour class or a `var(--…)` in the source names a token the stylesheet does not declare.

## Checks and distribution

```sh
npm run typecheck
npm test
npm run build
```

The build checks a reviewed runtime dependency allowlist and rejects private integrations and common credential formats in emitted text, notices and manifests. Rejected content is identified by asset and credential kind without printing the matched value. These checks supplement source/history secret scanning; arbitrary or encoded secrets require separate review. Keep credentials in server runtime configuration, outside browser bundles, `VITE_` variables and build arguments. Each build emits exact assets and `THIRD-PARTY-NOTICES.txt` for bundled code and fonts. The native server serves only the asset manifest and keeps its strict CSP, same-origin JSON mutation checks and API error responses. The repository source export inventories the console's separate lockfile as well as native packages.

See [console architecture](../../docs/console-architecture.md), the [server reference](../../packages/serve/README.md) and [live QA contract](../../docs/AUTOQA.md).
