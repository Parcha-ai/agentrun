// The server's learning code, as one surface: the note format (notes.ts), the checker (check.ts), the end-of-run prompt
// (reflect.ts), the grade's rubric, prompt and verdict (grade.ts), and the hidden-character and secret matchers they use
// (invisible.ts, secrets.ts). SPEC.md, beside it, is the learning folder's contract. The rest of the server imports it
// from here.
export { CAPS, checkProposal, mergeProblems, printable, type Base, type Change, type CheckInput, type Problem, type ProposalCheck, type ProposedNote, type Rule } from "./check.js";
export { GRADE_CAPS, GRADE_RUBRIC, gradePrompt, parseVerdict, type GradeInput, type IndexEntry, type NoteText, type Verdict, type VerdictItem } from "./grade.js";
export { hiddenCharacter } from "./invisible.js";
export { reflectPrompt } from "./reflect.js";
export { activeNotes, buildIndex, INDEX_BYTES, INDEX_FILE, INDEX_LINES, indexLine, loadedIndex, NOTE_FILE, NOTE_STATUSES, NOTE_TYPES, parseNoteFile, supersede, type LearnedNote, type NoteStatus, type NoteType } from "./notes.js";
export { MIN_SECRET, PRINT_MAX, redactSecrets, secretShapes, valueMatcher } from "./secrets.js";
