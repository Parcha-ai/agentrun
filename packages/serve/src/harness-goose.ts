// Goose on this server: installed by its owner (`<data>/harnesses/goose/goose`, by `agentrun harness install goose`),
// held to its pinned binary (harness-owned.ts).
import { ownerInstalled } from "./harness-owned.js";

export const GOOSE_ID = "goose";

/** Goose as an owner-installed harness: its pin, its install line and its not-installed code are its package's. */
export const GOOSE = ownerInstalled({ id: GOOSE_ID, label: "Goose", pin: (acp) => acp.GOOSE_PIN, installLine: (acp) => acp.GOOSE_INSTALL, notInstalled: (acp) => acp.GOOSE_NOT_INSTALLED });

export const { hidden: gooseHidden, missing: gooseMissing } = GOOSE;
