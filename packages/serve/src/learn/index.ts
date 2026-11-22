// The server's learning code, as one surface: a workflow draft's format and checks (workflow-draft.ts, check.ts), the
// owner's corrections (corrections.ts), and the hidden-character and secret matchers they use (invisible.ts,
// secrets.ts). SPEC.md, beside it, is the learning folder's contract. The rest of the server imports it from here.
export { CAPS, checkDraft, printable, unstorable, type Change, type DraftCheckInput, type Problem, type Rule } from "./check.js";
export { CORRECTIONS_CAP, CORRECTIONS_FILE, correctionLine, correctionsProblems, problemWords } from "./corrections.js";
export { hiddenCharacter } from "./invisible.js";
export { learnedSecretShapes, MIN_SECRET, PRINT_MAX, redactLearned, redactSecrets, secretShapes, valueMatcher } from "./secrets.js";
export { decodedStrings, draftDryRun, draftFiles, draftProblems, DRY_RUN_FAILED, frontKeys, frontMatter, held, isHeld, LEARNED_KEYS, LEARNED_MAX_TURNS, learnedFront, learnedPlace, learnedStatus, NO_TOOL_LIST, readmeOf, released, restorable, restoredLearned, retiredFrom, retiredLearned, setsStatus, statusOnOneLine, UNCLEAR_FRONT, unclearFront, WORKFLOW_NAME, WORKFLOWS_DIR, type DraftDryRun, type DraftProblem, type DraftReader, type LearnedPlace } from "./workflow-draft.js";
