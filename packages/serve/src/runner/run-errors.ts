// The errors a runner and a run's own process hand each other over their channel (run-channel.ts), made again on the
// other side as instances of their own class, so a check such as `instanceof Fenced` or `instanceof ClaimRefused` holds
// across the channel as it did in one process. Both sides register the same list.
import { ConversationBusy, ConversationIdle, ReadAfterWrite, ReadOnlySession, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import { CommandTaken, Fenced, RunFinal, SignInHandedTo, SignInMissing, StoreBusy, StoreClosed, StoreConstraint, StoreDeadline, StoreLaunchMissing, StoreWorkerLost } from "../store/store.js";
import { Unanswered } from "../store/postgres/connection.js";
import { LaunchUnreadable, UnknownHarness } from "./dispatch.js";
import { NeverFits } from "./harness-loops.js";
import { ClaimRefused } from "./loop-contract.js";
import { McpClaimRefused } from "./mcp-claim.js";
import { registerErrors } from "./run-channel.js";
import { ClaimLost } from "./runner.js";

/** Registers every error class a run's process and its runner hand each other (run-channel.ts registerErrors). */
export function registerRunErrors(): void {
  registerErrors({
    ClaimRefused, NeverFits, McpClaimRefused, ClaimLost, UnknownHarness, LaunchUnreadable,
    Fenced, CommandTaken, RunFinal, SignInHandedTo, SignInMissing, StoreBusy, StoreClosed, StoreConstraint, StoreDeadline, StoreLaunchMissing, StoreWorkerLost, Unanswered,
    ConversationBusy, ConversationIdle, ReadAfterWrite, ReadOnlySession, SessionFailed, StorageRequestError,
  });
}
