// Typechecked with the serve package (tsconfig.test.json), never run: a learned workflow's run is never given without
// its tool policy (#2153). Each @ts-expect-error below fails the typecheck if the call it marks compiles.
import { learnedWorkflowTool, type LearnedWorkflowRun } from "../src/learned-workflow.js";

const given = { workflows: [], granted: [], env: {}, work: "/nonexistent", models: {} as LearnedWorkflowRun["models"], modelOf: () => undefined };

// @ts-expect-error a run with no policy and no denyFrom
learnedWorkflowTool({ ...given });
// @ts-expect-error a run with a policy and no denyFrom
learnedWorkflowTool({ ...given, policy: () => "allow" });
// A run with both compiles.
learnedWorkflowTool({ ...given, policy: () => "allow", denyFrom: () => "default" });
