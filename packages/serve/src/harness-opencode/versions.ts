// The OpenCode build this adapter is pinned to and checked against, and the typed errors a host maps to a run's failure
// line when the installed build is not it. Written for AgentRun.
//
// The pin is exact: the adapter mirrors OpenCode's own per-session event log into the session's records and gives it
// back to a new process (`/sync/replay`), and that log's shape is OpenCode's internal one, which any release may change.

import { OPENCODE_VERSION } from "./binary.js";

/** The OpenCode CLI release this adapter is built and tested with (`opencode --version` prints it). */
export { OPENCODE_VERSION };

/** The install line for the pinned release (npm installs this platform's binary package with it). */
export const OPENCODE_INSTALL = `npm install --save-exact opencode-ai@${OPENCODE_VERSION}`;

/**
 * npm's integrity of the pinned launcher and of each platform package, as the registry publishes them. npm checks a
 * download against the lockfile's copy of these; test/pins.test.mjs keeps the repository's lockfile equal to them.
 */
export const OPENCODE_NPM_INTEGRITY: Readonly<Record<string, string>> = Object.freeze({
  "opencode-ai": "sha512-tEqMvQahfhdDj8vceYpXtoIrvjPXm5XRfetWnPN5YISueU7adNx9JcUA3zZ+2GKuDVgDpGdQe1ZLtCZDjqodvA==",
  "opencode-linux-x64": "sha512-i1qh7VooLGML9xX6ud93y0JA8j/1aPeDYRKjsmYXrJX1TjIWHgBBMkEbEJPZthpWbsJg//XfBgR6Kb7+NPaJiQ==",
  "opencode-linux-x64-baseline": "sha512-9kA+st3XXtCXMPx5f3Ld1u19uoHTO2u2Btt8a2cqhJ4GIqVbD1mXLevj3LHFEmtuQoFGk+UstGnl38sCqXj5sQ==",
  "opencode-linux-x64-musl": "sha512-y6nUbH3ViajN37KaVVy0/KnWv/i48Bx5QPv9Ul9ONJya1ossV7CHVb+ZNFc61M5GqlVtjCvZV7T0eBMqhJG7mg==",
  "opencode-linux-x64-baseline-musl": "sha512-kwt6hmTaI6nujjAzdAkXv3j2rDzXNOMfMk8Jf8bwacHtwUl8CWA2psDVg3nWyb4zByAa6F1jSIlmHCPHBq1K/Q==",
  "opencode-linux-arm64": "sha512-u2HFRI6v1nNMVKiV34An8XrGBxJeZ+RCg2tYu3SqlGODKqKsr5RoEbaX1tnsfGb+rETh9AJVX9kS8dSZXPufsA==",
  "opencode-linux-arm64-musl": "sha512-YxvpVPJ/jeevV93DVRiuOVbhkoJAuwQUadPDHPaw65aZkAKZ6OE7XySwCS+Rjlhzt7fPryisvAOjUtZkwfMBuQ==",
  "opencode-darwin-x64": "sha512-+DO7IMPTCrX12UJXnL4pL3ckcwR6BR6f6tA9QIlVQ5nZx66T5U7FRMJT4n5rsOnJxLM/pZ2vfX1G8vrnvXO8FA==",
  "opencode-darwin-x64-baseline": "sha512-rftvAoHBWPVkvwBLr3SQWRZvcIjyMTN0SlhMzlt+lgvoQBBGNEmZQ/7sS/Ux1oHsJV/++UDuLVso4n5L95YD5Q==",
  "opencode-darwin-arm64": "sha512-0MbSbKkmwVHtgP31GJyyECe6QVy4T7W4Wp7s2TsmXHTPPyf01ne3dWSX97X9dkNK28Lc6kt+zMPQUP/9GgDLZg==",
  "opencode-windows-x64": "sha512-xCVbrA8A/qQTAdBIKyhK5tx3/mcq18yF82Mi8phry0MJb2631nnnpxF9m6FFfWAVHyer4qFGrO7hbWXesHQ1Gg==",
  "opencode-windows-x64-baseline": "sha512-yRHN+TsfLjfLmdQVAVWqTGfGP1yq8YtUFy9Jw33XhlPIp77slBdCJrj2PC4amuEl6BJtaIQDhDFbpJ8+a5z7Qw==",
  "opencode-windows-arm64": "sha512-aySF/MDji5KO3I5yl9Ec4g8kW/QIx4Jj5FXwBhh/FrDu0w6L8HAOGH7cyjFb3t8TW7pxRkH3Ei3rfkWAE7cScw==",
});

/** The sha256 of the pinned native binary (`bin/opencode` in the platform package), per platform package, read from the
 *  packages those integrities name as npm installed them on Linux x64 (the two builds ship the same file). A binary from
 *  a package listed here runs only if it matches; one from a package not listed is checked by its package's version and
 *  the version it reports, and npm checked its package against the integrity above when it installed it. */
export const OPENCODE_BINARY_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "opencode-linux-x64": "7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c",
  "opencode-linux-x64-baseline": "7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c",
});

/** Which pin a mismatch is about: the binary's sha256, the version it reports, or the platform package's version. */
export type OpenCodePin = "binary_sha256" | "version" | "package_version";

/** The installed OpenCode is not the build this adapter is pinned to and checked with: nothing runs. */
export class OpenCodePinMismatch extends Error {
  readonly code = "OPENCODE_PIN_MISMATCH";
  constructor(readonly pin: OpenCodePin, readonly expected: string, readonly found: string, readonly path?: string) {
    super(`opencode: the OpenCode ${pin === "package_version" ? "platform package" : "binary"}${path ? ` at ${path}` : ""} is not the pinned build: its ${pin.replace("_", " ")} is ${found}, not ${expected}`);
    this.name = "OpenCodePinMismatch";
  }
}

/** No OpenCode binary to run: the host has not installed `opencode-ai` (or this platform's package), or the binary
 *  named could not be run. */
export class OpenCodeNotInstalled extends Error {
  readonly code = "OPENCODE_NOT_INSTALLED";
  constructor(readonly detail?: string) {
    super(`opencode: OpenCode ${OPENCODE_VERSION} is not installed${detail ? ` (${detail})` : ""}; ${OPENCODE_INSTALL}`);
    this.name = "OpenCodeNotInstalled";
  }
}
