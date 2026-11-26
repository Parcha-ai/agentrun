import type { Agent } from "@/lib/agentForm";
import { backendSdkOf } from "@/lib/backendSdk";
import { cliLearningOf } from "@/lib/cliLearning";

/** Whether the console runs this agent from its own page's Run box: an agent this server runs, not archived. A native,
 *  SDK or CLI agent runs where it lives, so its Run and Edit hand off to a coding agent instead. */
export const runsHere = (agent: Pick<Agent, "archived_at" | "definition">): boolean =>
  !agent.archived_at && !agent.definition.native && !backendSdkOf(agent.definition) && !cliLearningOf(agent.definition);
