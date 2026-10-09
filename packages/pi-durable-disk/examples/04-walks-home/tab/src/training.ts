// What the creature's brain is, as the label and the page state say it: no trained policy, a live checkpoint of a run in progress,
// the final policy, or a demo stand-in. One place holds the state and the facts the files reported (steps, training time, the
// trainer's own walk score), so removing a policy clears them together and nothing describes a policy that is gone.

import type { ProvenanceFacts } from './arrival.ts';

export type BrainState = 'untrained' | 'learning' | 'trained' | 'dummy';

export class TrainingState {
  state: BrainState = 'untrained';
  /** True once a final policy (home/policy.json, or one marked final) is installed; a late checkpoint then never replaces it. */
  final = false;
  /** The trainer's own checkpoint number when the file carries one, otherwise the count of installs. */
  checkpointN = 0;
  steps: number | null = null;
  wallS: number | null = null;
  reportedWalkM: number | null = null;

  /** The training file stays on the disk after the run is home: once the final policy is in, a checkpoint is stale. */
  acceptCheckpoint(): boolean {
    return !this.final;
  }

  install(kind: 'checkpoint' | 'final', facts: ProvenanceFacts): void {
    this.state = kind === 'checkpoint' ? 'learning' : 'trained';
    this.final = this.final || kind === 'final';
    this.checkpointN = facts.checkpoint ?? this.checkpointN + 1;
    this.steps = facts.steps;
    this.wallS = facts.wallS;
    this.reportedWalkM = facts.reportedWalk10sM;
  }

  /** The policy is gone (a new body, the stand-only button, the demo stand-in): no facts survive. */
  clear(state: 'untrained' | 'dummy'): void {
    this.state = state;
    this.final = false;
    this.checkpointN = 0;
    this.steps = null;
    this.wallS = null;
    this.reportedWalkM = null;
  }

  /** The label on the creature, in plain words. `policyName` names a stand-in when there is one. */
  label(policyName: string): string {
    return this.state === 'untrained' ? 'untrained: random moves'
      : this.state === 'learning' ? `learning: version ${this.checkpointN}`
      : this.state === 'trained' ? 'trained'
      : `${policyName} (not trained)`;
  }
}
