// The line every harness's system prompt starts with: today's date, in UTC, and where the run works. A model knows only
// the date its training ended, so a question about "the latest" release is answered from then unless the run says what
// day it is. One line for every harness, made as each turn starts, so a run resumed on a later day reads that day.

/** The environment line on `now`'s day, in UTC. */
export function environmentLine(now: Date = new Date()): string {
  return `Today is ${now.toISOString().slice(0, 10)} (UTC). You are running on AgentRun; your workspace is your working directory, and file paths are relative to it.`;
}
