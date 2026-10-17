import { describe, expect, it } from "vitest";
import {
	type Checkpoint,
	type CheckpointStats,
	type CheckpointVault,
	checkpointStats,
	localVault,
	type PullOptions,
	pullCheckpoint,
	restoreNotice,
	type SkipReason,
} from "../src/home/index.ts";

// What a host imports from `@parcha/pi-transport/home` to take checkpoints and to restore from them: the names must be
// there, and the types must fit together as a host writes them.
describe("the checkpoint names the home entry exports", () => {
	it("are there, and fit together", () => {
		const vault: CheckpointVault = localVault("/nonexistent-vault-directory");
		const stats: CheckpointStats = checkpointStats();
		const reason: SkipReason = "busy";
		const options: Pick<PullOptions, "vault" | "stats" | "maxPullBytes"> = { vault, stats, maxPullBytes: 1 };
		const checkpoint: Pick<Checkpoint, "at" | "excluded"> = { at: 0 };
		expect(typeof pullCheckpoint).toBe("function");
		expect(options.maxPullBytes).toBe(1);
		expect(stats.skipped[reason]).toBe(0);
		expect(restoreNotice(checkpoint, [])).toContain("restored from a checkpoint");
	});
});
