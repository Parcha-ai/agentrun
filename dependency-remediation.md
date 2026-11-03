# Console dependency remediation assessment

Assessed PR #1408 at committed head `3573f4a6f4f1a68b2a1c52161b0a363d2802315f`, on 2026-11-03. This assessment changed no tracked files; no candidate was installed, built or tested. Isolated experiments resolve package locks and query npm audit only.

## Current findings, baseline and scope

A fresh npm 11.21.0 `npm audit --package-lock-only --json` against the committed console lock reports **14 affected package entries: 7 moderate, 3 high and 4 critical**. These aggregate **47 unique advisory IDs**, rather than 14 individual advisories. The baseline audit has the same 14 package entries and exactly the same advisory-ID set. The initial supplied audit with 16 entries is stale: its extra `openapi-typescript`/`@redocly/openapi-core` entries predate the generator change to `openapi-typescript@6.7.6` and its scoped Undici override.

A separate fresh production-only lock audit (`--omit=dev`) reports **one high affected package entry: DOMPurify**. The other 13 entries belong to test, development or build dependencies. This distinction describes where code is used; it does not dismiss developer-machine or build-system vulnerabilities.

## Concrete remediation paths observed in isolated lock resolution

| Candidate changes from current console | Resulting npm audit | Compatibility status |
| --- | --- | --- |
| DOMPurify `3.2.3 → 3.4.17`; PostCSS `8.4.49 → 8.5.32`; all four direct Storybook packages `8.6.14 → 8.6.19` | **10 entries: 7 moderate, 1 high, 2 critical** | Same major/minor patch lines for Storybook; DOMPurify/PostCSS same major. Requires focused behavior/build checks before adoption. |
| Above, plus Vite `5.4.21 → 6.4.5` and Vitest `2.1.9 → 4.1.12` | **4 moderate; no high or critical** | Major tooling upgrades, but declared peer ranges resolve cleanly with existing React plugin and Storybook. Vitest removes the vulnerable Tinypool dependency and Vite-node chain. |
| Above, plus a scoped override of the Storybook docgen plugin's `glob` to `14.0.3` (resolves Minimatch `11.0.4`) | **0 reported findings** | Lock-resolution result only. Glob crosses four major versions beyond the plugin's declared `^10` range; compatibility must be demonstrated. Not a blanket safe-upgrade claim. |

The second path is a smaller supported toolchain step than npm's generic suggestions of Vite `8.3.5` and Vitest `5.1.0`. `@vitejs/plugin-react@4.3.4` accepts Vite 6, Storybook React-Vite `8.6.19` accepts Vite 6, and Vitest `4.1.12` accepts Vite 6/7/8. The existing Node floor of 22.19.0 meets these candidate engines. Registry resolution raised no peer-dependency errors.

The four remaining moderate entries on that path are all one Storybook development chain: `@storybook/react-vite → @joshwooding/vite-plugin-react-docgen-typescript@0.5.0 → glob@10.5.0 → minimatch@9.0.9`. The plugin calls `globSync`; its dependency remains `glob:^10.0.0` even in Storybook `8.6.19`. Glob's advisory is patched at `14.0.2`, and Minimatch's at `11.0.1`. Simply upgrading Storybook within 8.6 does not clear these. [Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249).

A scoped experimental override that resolved zero findings was:

```json
{
  "overrides": {
    "openapi-typescript": { "undici": "6.29.1" },
    "@joshwooding/vite-plugin-react-docgen-typescript": { "glob": "14.0.3" }
  }
}
```

This preserves the existing generator override; it does not globally replace every Glob or Minimatch. A future implementation should validate Storybook's actual docgen/story discovery with that override, or use an upstream-supported plugin release instead. Even the latest queried plugin `0.9.0` declares `glob:^13.0.6`, still inside the current advisory range. Storybook `10.6.5` itself declares plugin `^0.7.0`, so a major Storybook migration is not automatically a complete Glob remediation.

## Runtime and tool exposure

- **DOMPurify is bundled runtime code.** `src/lib/format.ts:40` sanitizes run Markdown parsed by Marked; `src/components/RunFiles.tsx:72` sanitizes authenticated HTML file text before rendering it in a sandboxed iframe. Both pass strings with default options. The source does not use `IN_PLACE`, custom hooks, `setConfig`, custom-element handling or Trusted Types mode, so many mode-specific advisories do not describe the current call shape. Earlier mutation/XSS advisories still apply to the installed version; this assessment does not establish exploitability of every advisory. `3.4.17` clears the recorded range set and contains upstream sanitization hardening. [DOMPurify release](https://github.com/cure53/DOMPurify/releases/tag/3.4.17).
- **Storybook is development/build tooling.** Its origin-validation/code-injection and WebSocket issues concern a running development server; the console's script binds Storybook to loopback. Loopback does not eliminate malicious-website interaction. The environment-variable advisory also concerns generated Storybook manager output. The standalone product serves built console files, not a Storybook dev server. The patched 8.6 line is `8.6.19`; that patch includes security-driven behavior changes, so its static build and local catalog still need verification. [Storybook advisory](https://github.com/advisories/GHSA-f2ph-cmg5-wxc8).
- **Vite/esbuild are build and local-development tooling.** The standalone server does not run Vite or esbuild. The Vite development proxy can carry a locally configured server credential, making source-read/dev-server boundaries relevant. Current scripts bind Vite to loopback. Vite `6.4.5` avoids the current Vite ranges (through `6.4.3`) and uses esbuild `^0.25`, clearing esbuild's `<=0.24.2` advisory. The top-level installed esbuild is already `0.25.12`; the vulnerable copy is nested under Vite at `0.21.5`.
- **Vitest/Mocker/Tinypool are test tooling.** The normal script is `vitest run`; neither `@vitest/ui` nor `@vitest/browser` is a direct dependency, and the source does not start a remote Vitest UI service. Critical UI-server file execution and prototype-pollution-to-worker execution are conditional developer/test-process exposures. The current test runner still uses affected dependencies. Vitest `4.1.12` clears the relevant Mocker ranges and no longer resolves Tinypool in the candidate graph. If Tinypool were used directly, both recorded critical advisories require at least `2.1.2`. [Vitest Mocker advisory](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Tinypool advisory](https://github.com/advisories/GHSA-85c8-ppgw-ccpr).
- **PostCSS is build tooling.** It processes the repository's CSS/Tailwind build. Source-map file reads and CSS stringification XSS are not a PostCSS service exposed by the standalone server, but remain relevant if build inputs are attacker-controlled. `8.5.32` clears the recorded affected ranges through `8.5.22`.
- **Glob/Minimatch are Storybook docgen tooling.** The source does not expose a public glob endpoint; the plugin searches local TypeScript files. Current usage therefore differs from a request-facing service accepting attacker-selected patterns. The audit remains valid for the installed versions.

## Upgrade work, if authorized

A contained implementation would first update the exact direct pins and console lock, then regenerate dependency inventory/notices. Vite 6 and Vitest 4 are real major migrations: inspect the Vite boundary plugin, library output and test configuration, then run the existing typecheck and console suite, console/library/Storybook builds, strict installed-package consumers and native contract check. Existing sanitization/HTML/browser tests provide the first DOMPurify checks. Browser and package evidence must be refreshed if bundle bytes change.

The isolated result does not justify forcing newer transitive versions into the existing Vitest 2 graph or using `npm audit fix --force`. The relevant official migration guides are [Vite 5 → 6](https://v6.vite.dev/guide/migration.html) and [Vitest 3/4 migration](https://v4.vitest.dev/guide/migration.html). No migration has been carried out during this assessment.

## Direct installed versions

All direct installed versions were read from the installed package manifests and matched both the committed exact pin and lock. Unaffected direct packages are included to make the assessed graph explicit.

| Direct package | Manifest = lock = installed | Scope | Audit status |
| --- | --- | --- | --- |
| `@fontsource/jetbrains-mono` | `5.1.1` | runtime | not listed |
| `@fontsource/schibsted-grotesk` | `5.1.1` | runtime | not listed |
| `clsx` | `2.1.1` | runtime | not listed |
| `dompurify` | `3.2.3` | runtime | high |
| `lucide-react` | `0.468.0` | runtime | not listed |
| `marked` | `15.0.6` | runtime | not listed |
| `react` | `18.3.1` | runtime | not listed |
| `react-dom` | `18.3.1` | runtime | not listed |
| `@storybook/addon-viewport` | `8.6.14` | development/build | not listed |
| `@storybook/react` | `8.6.14` | development/build | not listed |
| `@storybook/react-vite` | `8.6.14` | development/build | moderate |
| `@types/react` | `18.3.18` | development/build | not listed |
| `@types/react-dom` | `18.3.5` | development/build | not listed |
| `@vitejs/plugin-react` | `4.3.4` | development/build | not listed |
| `autoprefixer` | `10.4.20` | development/build | not listed |
| `jsdom` | `25.0.1` | development/build | not listed |
| `openapi-typescript` | `6.7.6` | development/build | not listed |
| `postcss` | `8.4.49` | development/build | high |
| `storybook` | `8.6.14` | development/build | critical |
| `tailwindcss` | `3.4.17` | development/build | not listed |
| `typescript` | `5.7.3` | development/build | not listed |
| `vite` | `5.4.21` | development/build | high |
| `vitest` | `2.1.9` | development/build | critical |

## Affected installed dependency chains

| Affected entry | Installed version(s) | Fix target / relationship |
| --- | --- | --- |
| `@joshwooding/vite-plugin-react-docgen-typescript` | `0.5.0` | 0.5.0 → its Glob/Minimatch chain must change; no compatible patch-only fix found |
| `@storybook/core` | `8.6.14` | 8.6.19 via matched Storybook direct pins |
| `@storybook/react-vite` | `8.6.14` | 8.6.19 fixes its Storybook line, but inherited Glob chain remains |
| `@vitest/mocker` | `2.1.9` | 4.1.12 via Vitest 4.1.12 |
| `dompurify` | `3.2.3` | 3.4.17 |
| `esbuild` | `0.21.5` | >=0.25.0 through Vite 6.4.5; nested 0.21.5 is affected |
| `glob` | `10.5.0` | minimum14.0.2; isolated scoped candidate14.0.3 |
| `minimatch` | `9.0.9` | minimum11.0.1; isolated scoped candidate11.0.4 |
| `postcss` | `8.4.49` | 8.5.32 |
| `storybook` | `8.6.14` | 8.6.19 (all direct Storybook packages together) |
| `tinypool` | `1.1.1` | minimum2.1.2 if retained; absent from Vitest4.1.12 candidate |
| `vite` | `5.4.21` | 6.4.5; major5→6 |
| `vite-node` | `2.1.9` | removed from Vitest4.1.12 candidate |
| `vitest` | `2.1.9` | 4.1.12; major2→4 |

## Advisory titles and selected fix targets

This appendix deduplicates the 47 current advisory IDs. Titles longer than 23 words are shortened. Each target is the selected graph remediation, not a claim that it is the earliest patched version of every individual issue.

| Package | Advisory | Selected target |
| --- | --- | --- |
| `@storybook/core` | [Storybook: Missing origin validation in Storybook preview allows code injection from malicious websites](https://github.com/advisories/GHSA-f2ph-cmg5-wxc8) | 8.6.19 |
| `@storybook/core` | [Storybook dev server vulnerable to code injection from the local network](https://github.com/advisories/GHSA-px85-f4q5-jh77) | 8.6.19 |
| `@vitest/mocker` | [Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | Vitest4.1.12 |
| `@vitest/mocker` | [Vitest: Code injection via unauthenticated manual mock registration](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) | Vitest4.1.12 |
| `dompurify` | [DOMPurify's ADD_TAGS function form bypasses FORBID_TAGS due to short-circuit evaluation](https://github.com/advisories/GHSA-39q2-94rc-95cp) | 3.4.17 |
| `dompurify` | [DOMPurify: IN_PLACE hook removal leaves a detached subtree executable, causing XSS](https://github.com/advisories/GHSA-55q2-fjhq-7xh7) | 3.4.17 |
| `dompurify` | [DOMPurify: IN_PLACE returns a force-removed rawtext root whose text carries attacker markup — pure HTML reparse executes](https://github.com/advisories/GHSA-6688-9rhm-gjv2) | 3.4.17 |
| `dompurify` | [DOMPurify: Hook mutation of `data.allowedTags` / `data.allowedAttributes` permanently pollutes `DEFAULT_ALLOWED_TAGS` / `DEFAULT_ALLOWED_ATTR`](https://github.com/advisories/GHSA-76mc-f452-cxcm) | 3.4.17 |
| `dompurify` | [DOMPurify: `CUSTOM_ELEMENT_HANDLING` bypasses `afterSanitizeElements` for allowed custom elements.](https://github.com/advisories/GHSA-c2j3-45gr-mqc4) | 3.4.17 |
| `dompurify` | [DOMPurify: SMIL attributeName=href guard is skipped when PARSER_MEDIA_TYPE is application/xhtml+xml](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f) | 3.4.17 |
| `dompurify` | [DOMPurify USE_PROFILES prototype pollution allows event handlers](https://github.com/advisories/GHSA-cj63-jhhr-wcxv) | 3.4.17 |
| `dompurify` | [DOMPurify ADD_ATTR predicate skips URI validation](https://github.com/advisories/GHSA-cjmm-f4jc-qw8r) | 3.4.17 |
| `dompurify` | [DOMPurify: Permanent `ALLOWED_ATTR` pollution via `setConfig()` bypassing the hook clone-guard (incomplete fix of the 3.4.7 hook-pollution patch)](https://github.com/advisories/GHSA-cmwh-pvxp-8882) | 3.4.17 |
| `dompurify` | [DOMPurify has a SAFE_FOR_TEMPLATES bypass in RETURN_DOM mode](https://github.com/advisories/GHSA-crv5-9vww-q3g8) | 3.4.17 |
| `dompurify` | [DOMPurify: SAFE_FOR_TEMPLATES bypass - template expressions survive sanitization inside <template> content when using DOM output modes](https://github.com/advisories/GHSA-gvmj-g25r-r7wr) | 3.4.17 |
| `dompurify` | [DOMPurify: FORBID_TAGS bypassed by function-based ADD_TAGS predicate (asymmetry with FORBID_ATTR fix)](https://github.com/advisories/GHSA-h7mw-gpvr-xq4m) | 3.4.17 |
| `dompurify` | [DOMPurify is vulnerable to mutation-XSS via Re-Contextualization](https://github.com/advisories/GHSA-h8r8-wccr-v5f2) | 3.4.17 |
| `dompurify` | [DOMPurify: Cross-realm IN_PLACE sanitization leaves executable markup intact via realm-bound `instanceof` checks](https://github.com/advisories/GHSA-hpcv-96wg-7vj8) | 3.4.17 |
| `dompurify` | [DOMPurify IN_PLACE: hook that removes a parent or sibling leaves the detached subtree's event handlers armed (incomplete fix for GHSA-p98j-92pf-mc4p)](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr) | 3.4.17 |
| `dompurify` | [DOMPurify: IN_PLACE mode preserves attributes of a clobbered root element, allowing XSS via attacker-controlled root DOM](https://github.com/advisories/GHSA-r47g-fvhr-h676) | 3.4.17 |
| `dompurify` | [DOMPurify IN_PLACE Sanitization Bypass via Attached Shadow Root Inside <template>.content](https://github.com/advisories/GHSA-rp9w-3fw7-7cwq) | 3.4.17 |
| `dompurify` | [DOMPurify contains a Cross-site Scripting vulnerability](https://github.com/advisories/GHSA-v2wj-7wpq-c8vv) | 3.4.17 |
| `dompurify` | [DOMPurify contains a Cross-site Scripting vulnerability](https://github.com/advisories/GHSA-v8jm-5vwx-cfxm) | 3.4.17 |
| `dompurify` | [DOMPurify: Prototype Pollution to XSS Bypass via CUSTOM_ELEMENT_HANDLING Fallback](https://github.com/advisories/GHSA-v9jr-rg53-9pgp) | 3.4.17 |
| `dompurify` | [DOMPurify allows Cross-site Scripting (XSS)](https://github.com/advisories/GHSA-vhxf-7vqr-mrjg) | 3.4.17 |
| `dompurify` | [DOMPurify: Trusted Types policy survives `clearConfig()` and can poison later `RETURN_TRUSTED_TYPE` output](https://github.com/advisories/GHSA-vxr8-fq34-vvx9) | 3.4.17 |
| `dompurify` | [DOMPurify: `IN_PLACE` mode trusts attacker-controlled `nodeName` on live non-form nodes, allowing script retention and XSS via attacker-supplied DOM objects](https://github.com/advisories/GHSA-x4vx-rjvf-j5p4) | 3.4.17 |
| `esbuild` | [esbuild enables any website to send any requests to the development server and read the response](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | >=0.25 via Vite6.4.5 |
| `glob` | [Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | 14.0.3 scoped candidate |
| `minimatch` | [minimatch has potential denial of service via globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) | 11.0.4 via patched Glob |
| `postcss` | [PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments](https://github.com/advisories/GHSA-6g55-p6wh-862q) | 8.5.32 |
| `postcss` | [PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | 8.5.32 |
| `postcss` | [PostCSS has XSS via Unescaped </style> in its CSS Stringify Output](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | 8.5.32 |
| `postcss` | [PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure](https://github.com/advisories/GHSA-r28c-9q8g-f849) | 8.5.32 |
| `storybook` | [Storybook manager bundle may expose environment variables during build](https://github.com/advisories/GHSA-8452-54wp-rmv6) | 8.6.19 |
| `storybook` | [Storybook Dev Server is Vulnerable to WebSocket Hijacking](https://github.com/advisories/GHSA-mjf5-7g4m-gx5w) | 8.6.19 |
| `tinypool` | [Tinypool: Prototype Pollution gadget in worker options leads to Remote Code Execution](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) | removed via Vitest4.1.12; or >=2.1.2 |
| `tinypool` | [Tinypool: Prototype Pollution Gadget to RCE in run() options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | removed via Vitest4.1.12; or >=2.1.2 |
| `vite` | [Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | 6.4.5 |
| `vite` | [launch-editor: `fs.existsSync()` existence check can be bypassed on Windows](https://github.com/advisories/GHSA-587h-7wmj-h5pm) | 6.4.5 |
| `vite` | [launch-editor: escapeCmdArgs() omits % escaping on Windows](https://github.com/advisories/GHSA-698v-4r3x-3vcv) | 6.4.5 |
| `vite` | [Vite: Cross origin script execution through Vite custom middleware](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) | 6.4.5 |
| `vite` | [vite: `server.fs.deny` bypass on Windows alternate paths](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | 6.4.5 |
| `vite` | [launch-editor: Editor CLI flag misinterpretation causing arbitrary command execution for some editors](https://github.com/advisories/GHSA-r825-w8mm-5pxw) | 6.4.5 |
| `vite` | [Vite: Files outside `server.fs.allow` could be served when project paths match system paths on non-Windows machine](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) | 6.4.5 |
| `vite` | [launch-editor: NTLMv2 hash disclosure via UNC path handling on Windows](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) | 6.4.5 |
| `vitest` | [When Vitest UI server is listening, arbitrary file can be read and executed](https://github.com/advisories/GHSA-5xrq-8626-4rwp) | 4.1.12 |

## Evidence limits

All candidate results came from copied manifests/locks in fresh disposable directories using `npm install --package-lock-only --ignore-scripts --no-audit` and separate `npm audit --package-lock-only --json`. This downloads registry metadata and resolves dependency versions; it does not execute dependency scripts, install candidate node_modules, compile code, run tests or prove runtime compatibility. No broad remediation was applied, no lockfile changed in the tracked checkout, and no PR integration, CI rerun or publication occurred.
