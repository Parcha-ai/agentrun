// Which statements of a Postgres migration a runner of an earlier build cannot run beside (migrate.ts RUNNERS_BREAKING):
// a migration past LAST_UNMARKED with any of them carries the header, or the migration lint (its test) fails. The rule
// is the deploy order's: the server migrates first, under runners of the earlier release that keep running; a schema
// change those runners' statements no longer fit (a table or column they read gone or renamed, a type they write changed,
// a column they never write made NOT NULL) fails their runs. Such a change lands in two releases: the additive half first,
// and the destructive cleanup one release later, marked, which raises the runner floor.
//
// It reads statements, never meaning: a tightened constraint an earlier runner's writes break (a new UNIQUE or CHECK on
// what it writes) is not found here, and its author marks it as well.

/** One statement of a migration an earlier build's runner cannot run beside, and why. */
export interface BreakingStatement {
  readonly why: string;
  /** The statement, its comments and string literals cut, on one line. */
  readonly statement: string;
}

/** `sql` with its comments gone and every string literal's text and dollar-quoted body emptied: what is left is the
 *  statements' own words, so a refusal's text or a function's body is never read as a statement. */
function bare(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      i = end === -1 ? sql.length : end + dollar[0].length;
      out += "''";
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      i = j + 1;
      out += "''";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Each kind of statement an earlier build's runner cannot run beside: tested on one statement, upper-cased, with its
 *  whitespace on one line. */
const BREAKING: readonly { readonly why: string; readonly test: (statement: string) => boolean }[] = [
  // DROP TABLE, DROP COLUMN, DROP INDEX (an ON CONFLICT of an earlier runner may name it), DROP CONSTRAINT (a unique one
  // too), DROP DEFAULT (an earlier runner's insert may leave the column out). DROP NOT NULL only loosens, and a trigger
  // is the database's own work, which no runner's statement names.
  { why: "drops what an earlier runner may read or write", test: (s) => /\bDROP\b/.test(s.replace(/\bDROP\s+NOT\s+NULL\b|^DROP\s+TRIGGER\b/g, "")) },
  { why: "renames what an earlier runner names", test: (s) => /\bRENAME\b/.test(s) },
  { why: "changes a column's type", test: (s) => /\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/.test(s) },
  { why: "makes a column NOT NULL that an earlier runner may leave empty", test: (s) => /\bSET\s+NOT\s+NULL\b/.test(s) },
  {
    why: "adds a NOT NULL column with no default, which an earlier runner's inserts leave out",
    test: (s) => /^ALTER\s+TABLE\b/.test(s) && addedColumns(s).map(outerWords).some((column) => /\bNOT\s+NULL\b/.test(column) && !/\bDEFAULT\b/.test(column) && !/\bGENERATED\b/.test(column)),
  },
];

/** `clause` with what each parenthesis holds emptied: a CHECK's `x IS NOT NULL` is no NOT NULL of the column's own. */
function outerWords(clause: string): string {
  let out = clause;
  for (let before = ""; before !== out; ) {
    before = out;
    out = out.replace(/\([^()]*\)/g, "()");
  }
  return out;
}

/** Each ADD COLUMN clause of an ALTER TABLE statement, up to the next top-level comma. */
function addedColumns(statement: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= statement.length; i++) {
    const c = statement[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if ((c === "," && depth === 0) || i === statement.length) {
      clauses.push(statement.slice(start, i));
      start = i + 1;
    }
  }
  return clauses.filter((clause) => /\bADD\s+COLUMN\b/.test(clause) || /^\s*ADD\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|CHECK\b|FOREIGN\b|EXCLUDE\b)/.test(clause.replace(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s*/, "")));
}

/** The statements of `sql` an earlier build's runner cannot run beside (BREAKING), in their order. */
export function breakingStatements(sql: string): BreakingStatement[] {
  const found: BreakingStatement[] = [];
  for (const raw of bare(sql).split(";")) {
    const statement = raw.replace(/\s+/g, " ").trim();
    if (statement === "") continue;
    const upper = statement.toUpperCase();
    for (const kind of BREAKING) if (kind.test(upper)) found.push({ why: kind.why, statement });
  }
  return found;
}
