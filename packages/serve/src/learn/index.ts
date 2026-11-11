// The server's learning code, as one surface: the note format (notes.ts), a skill's and a workflow draft's (skills.ts),
// the checker (check.ts), the end-of-run prompt (reflect.ts), the grade's rubric, prompt and verdict (grade.ts), and the
// hidden-character and secret matchers they use (invisible.ts, secrets.ts). SPEC.md, beside it, is the learning folder's contract. The rest of the server imports it
// from here.
export { CAPS, checkNote, checkProposal, mergeProblems, printable, supersededBy, unstorable, type Base, type Change, type CheckInput, type Problem, type ProposalCheck, type ProposedNote, type Rule } from "./check.js";
export { GRADE_CAPS, GRADE_RUBRIC, gradedFiles, gradedItems, gradePrompt, parseVerdict, shortMessage, UNREADABLE_REASON, type GradeInput, type IndexEntry, type NoteText, type Verdict, type VerdictItem } from "./grade.js";
export { hiddenCharacter } from "./invisible.js";
export { ANSWER_MAX, NOTE_BLOCK, parseReflection, reflectAgain, reflectDryRun, reflectPrompt, SKILL_BLOCK, WORKFLOW_BLOCK, type LearnedBlock, type Reflection } from "./reflect.js";
export { activeNotes, approve, buildIndex, INDEX_BYTES, INDEX_FILE, INDEX_LINES, indexLine, loadedIndex, mergedNote, NOTE_FILE, NOTE_ORIGINS, NOTE_STATUSES, NOTE_TYPES, parseNoteFile, retire, supersede, type LearnedNote, type NoteOrigin, type NoteStatus, type NoteType } from "./notes.js";
export { MIN_SECRET, PRINT_MAX, redactSecrets, secretShapes, valueMatcher } from "./secrets.js";
export { draftDryRun, draftFiles, draftProblems, DRY_RUN_FAILED, frontKeys, held, isHeld, LEARNED_KEYS, LEARNED_MAX_TURNS, learnedFront, learnedName, learnedPlace, learnedStatus, NO_TOOL_LIST, readmeOf, released, retiredLearned, servedSkill, setsStatus, SKILL_NAME, SKILLS_DIR, skillProblems, WORKFLOW_NAME, WORKFLOWS_DIR, type DraftDryRun, type DraftProblem, type DraftReader, type LearnedPlace } from "./skills.js";
