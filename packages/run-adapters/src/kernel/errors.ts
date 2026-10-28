// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-world/src/errors.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: only the EffectFailure class is kept from that file, identical because the copied process files throw it; everything else here is written for AgentRun.
//
// The errors the copied harness code throws and catches, by the names it uses.
import type { EffectError } from "./types.js";

/** An effect failed; `error` is what its records say. A memoized failure is thrown again as this. */
export class EffectFailure extends Error {
  constructor(readonly error: EffectError) {
    super(error.message);
    this.name = "EffectFailure";
  }
}

/** An effect was stopped before it reported its outcome. */
export class EffectInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectInterrupted";
  }
}

/** Rebuild the drive from the session's records, in this process. */
export class Restart extends Error {
  constructor(reason: string) {
    super(`restart: ${reason}`);
    this.name = "Restart";
  }
}

/** The session's records cannot be used as they are (a missing blob): no rebuild helps. */
export class Fatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fatal";
  }
}

/** The harness cannot run this turn (no sandbox, a version mismatch, a cap reached); the turn ends with this text. */
export class Unavailable extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(message: string, options: { code?: string; hint?: string } = {}) {
    super(message);
    this.name = "Unavailable";
    this.code = options.code ?? "unavailable";
    if (options.hint !== undefined) this.hint = options.hint;
  }
}
