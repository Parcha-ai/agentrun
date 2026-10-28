// The Codex build this adapter is pinned to and checked against, and the typed errors a host maps to a run's failure
// line when the installed build is not it. Written for AgentRun.

/** The Codex CLI release this adapter is built and tested with (`codex --version` prints `codex-cli <it>`). */
export const CODEX_VERSION = "0.164.0";

/** The install line for the pinned release (npm installs this platform's binary package with it). */
export const CODEX_INSTALL = `npm install --save-exact @openai/codex@${CODEX_VERSION}`;

/**
 * npm's integrity of the pinned launcher and of each platform package (an npm alias of
 * `@openai/codex@<version>-<platform>`), as the registry publishes them. npm checks a download against the lockfile's
 * copy of these; test/pins.test.mjs keeps the repository's lockfile equal to them.
 */
export const CODEX_NPM_INTEGRITY: Readonly<Record<string, string>> = Object.freeze({
  "@openai/codex": "sha512-TWj7UGyPRe3Pj/A3ddNAxs1te3a/W/xAd+J0LHrrFTmsSfahGMOLF/vn88D3QCIgAT3B1rm1y/Z3NYE0rx6cZQ==",
  "@openai/codex-linux-x64": "sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==",
  "@openai/codex-linux-arm64": "sha512-LL5iTQjyDL4YRX44EWqhIfEQ5uGnmgxkQBJSxjZSeJ8L1Og83pdlzUJW/PRJ76oaVwOVgh6HXwuPEiBNEHU4lg==",
  "@openai/codex-darwin-x64": "sha512-lIe+udnguPGzBezkgbkj2Eaz0YqOhNXT7jja136Fj0sXfI+UKNS2icmaK14GcoRAgeVEpDTtC1ftamWBPmD1zg==",
  "@openai/codex-darwin-arm64": "sha512-pDizgOUAtq3/k3AbUFHbaU19WpYKCja+oFpNSTLKrDQj4lTUNSDuTPJip4uQVn2/1EipQdpQrGMOQBVuI1znAA==",
  "@openai/codex-win32-x64": "sha512-urWPhwh9YavuoAPIkmVYKBTtd5OtGVL4Ki0Fb28dhK/Mz6Pt4LSy+gbRrZFz5+RXrw9ubvXuXDCcd8beYcWhDg==",
  "@openai/codex-win32-arm64": "sha512-Zkzt8HNmB/vOnlDo5D7IOlrt5rHaxYQB7iGbNP7bHcXZtrk6gaD7UriwaieGYJpcf8DqAT/0tqzY4xbs8ZwbmQ==",
});

/** The sha256 of the pinned native binary (`vendor/<target>/bin/codex` in the platform package), per target, read from
 *  the published packages those integrities name. A binary for a target listed here runs only if it matches. */
export const CODEX_BINARY_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "x86_64-unknown-linux-musl": "b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306",
  "aarch64-unknown-linux-musl": "8813c8d8a4cea2eeba271b72ab22f49628b184b24ab18dbef06b4ce41e9a8d39",
  "x86_64-apple-darwin": "d7e19691e0c1945612475ee8ab32e59ead55472e976b5cea1682d827d34dbba1",
  "aarch64-apple-darwin": "d8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf",
});

/** Which pin a mismatch is about: the binary's sha256, the version it reports, or the platform package's version. */
export type CodexPin = "binary_sha256" | "version" | "package_version";

/** The installed Codex is not the build this adapter is pinned to and checked with: nothing runs. */
export class CodexPinMismatch extends Error {
  readonly code = "CODEX_PIN_MISMATCH";
  constructor(readonly pin: CodexPin, readonly expected: string, readonly found: string, readonly path?: string) {
    super(`agentrun-codex: the Codex ${pin === "package_version" ? "platform package" : "binary"}${path ? ` at ${path}` : ""} is not the pinned build: its ${pin.replace("_", " ")} is ${found}, not ${expected}`);
    this.name = "CodexPinMismatch";
  }
}

/** No Codex binary to run: the host has not installed `@openai/codex` (or this platform's package), or the binary named
 *  could not be run. */
export class CodexNotInstalled extends Error {
  readonly code = "CODEX_NOT_INSTALLED";
  constructor(readonly detail?: string) {
    super(`agentrun-codex: Codex ${CODEX_VERSION} is not installed${detail ? ` (${detail})` : ""}; ${CODEX_INSTALL}`);
    this.name = "CodexNotInstalled";
  }
}
