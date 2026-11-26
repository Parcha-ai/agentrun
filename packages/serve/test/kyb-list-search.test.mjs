// The kyb template's whole-file sanctions search (templates/kyb/rules/SANCTIONS.md, method 3) on the list owners' own
// rows its eval cases save. The commands are read from the rule itself, their placeholders filled, so the rule and what
// it finds stay together: each must pass the agent's read-only bash policy, and each must find the entry it is for.
// - A person's names in the UN file are on lines of their own. UN TAi.002 is MOHAMMAD / HASSAN / AKHUND; AKHUND is on 30
//   lines, past the 20 a search reads, so the rule narrows it with a second word. Narrowing lines (the rule before this
//   change) gives nothing back; narrowing whole records gives TAi.002. The case's UN file holds every INDIVIDUAL of the
//   real file that holds AKHUND, HASSAN or MOHAMMAD, so these searches find there what they find in the whole file. Its
//   eval case can't go red on the old rule: TAi.002 is the first record that holds AKHUND, and agents read around the
//   first hit. This test is that rule's red.
// - A short name: ADF Ltd leaves ADF, no word of 4 letters, which the rule before this change gave no search. Searched
//   whole as a word, it finds UN CDe.001, UK DRC0015 and EU 7539, and not a word that holds those letters.
// - An EU row runs to 960 characters, and a long remark puts a person's function, birth place and citizenship past the
//   500 the rule once cut each row to. The record is read by column instead, with the header line naming each one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkReadOnly } from "../dist/bash-read-only.js";

const KYB = new URL("../templates/kyb/", import.meta.url);
const rule = readFileSync(new URL("rules/SANCTIONS.md", KYB), "utf8");
/** The rule's one command (in backticks) that starts with `start`. */
const ruled = (start) => {
  const found = [...rule.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((c) => c.startsWith(start));
  assert.equal(found.length, 1, `SANCTIONS.md gives one command that starts ${start}: ${JSON.stringify(found)}`);
  return found[0];
};
const fill = (command, word, second) => command.replaceAll("'WORD'", `'${word}'`).replaceAll("'SECOND'", `'${second}'`).replaceAll("'ADF'", `'${word}'`);

/** A run folder holding a case's saved lists at the paths the rule names. */
function folderOf(caseName) {
  const dir = mkdtempSync(join(os.tmpdir(), "kyb-search-"));
  mkdirSync(join(dir, "lists"));
  const paths = { "consolidated.xml": "un.txt", "UK-Sanctions-List.csv": "uk.csv", csvFullSanctionsList: "eu.txt", "/SDN.CSV": "ofac-sdn.csv" };
  const fixture = JSON.parse(readFileSync(new URL(`evals/${caseName}/fixtures/web.json`, KYB), "utf8"));
  for (const answer of fixture.save.answers) {
    const key = Object.keys(paths).find((k) => answer.url.includes(k));
    if (key) writeFileSync(join(dir, "lists", paths[key]), answer.text);
  }
  return dir;
}
/** A command run as the agent's shell would run it, after the policy takes it. */
function run(command, dir) {
  checkReadOnly(command, [dir]);
  return execFileSync("bash", ["-c", command], { cwd: dir, encoding: "utf8" });
}
const grepP = (() => { try { execFileSync("grep", ["-P", "x"], { input: "x" }); return true; } catch { return false; } })();

test("a common name in the UN file: narrowing lines loses TAi.002, narrowing whole records finds it", { skip: grepP ? false : "this grep has no -P" }, (t) => {
  const dir = folderOf("list-file-split-name");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run("grep -c -i -F -e 'AKHUND' lists/un.txt", dir).trim(), "30", "AKHUND alone comes back past the 20 lines a search reads");
  // The rule before this change, as it narrowed every file: lines that hold both words.
  assert.equal(run("grep -n -i -F -e 'AKHUND' lists/un.txt | grep -i -F -e 'HASSAN' | cut -c1-500 | head -n 20", dir).trim(), "");
  const records = fill(ruled("cat lists/un.txt | tr -d"), "AKHUND", "HASSAN");
  assert.deepEqual(run(records, dir).trim().split("\n"), ["<REFERENCE_NUMBER>TAi.002"]);
  const near = fill(ruled("grep -n -i -F -B 3 -A 3"), "AKHUND", "HASSAN");
  assert.match(run(near, dir), /^\d+-\s*<SECOND_NAME>HASSAN<\/SECOND_NAME>$/m, "the fallback without -P finds his other name beside AKHUND");
  // The OFAC, EU and UK rows hold a whole name: there narrowing rows finds him.
  const rows = fill(ruled("grep -i -F -e 'WORD' lists/uk.csv | grep"), "AKHUND", "HASSAN");
  assert.match(run(rows, dir), /AFG0006,7172,TAi\.002,AKHUND,MOHAMMAD,HASSAN/);
});

test("a short name is searched whole as a word: ADF finds UN CDe.001, UK DRC0015 and EU 7539, never inside a longer word", (t) => {
  const dir = folderOf("list-file-short-name");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const short = ruled("grep -n -i -w -F");
  const found = (file) => run(fill(short, "ADF", "").replace("lists/uk.csv", file), dir);
  assert.match(found("lists/un.txt"), /<FIRST_NAME>ADF<\/FIRST_NAME>/);
  assert.match(found("lists/uk.csv"), /,DRC0015,13189,CDe\.001,ADF \(Allied Democratic Forces\),/);
  assert.match(found("lists/eu.txt"), /;7539;EU\.3651\.51;/);
  writeFileSync(join(dir, "lists", "words.txt"), "GRADFORD HOLDINGS\nMADFIELD LTD\n");
  assert.equal(found("lists/words.txt"), "", "grep -w finds no word that only holds the letters");
});

test("an EU record is read by column, whole: EU 603's birth place, citizenship and function, past a 500-character cut", (t) => {
  const dir = folderOf("list-file-split-name");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The rule before this change: every row of the entity, cut to 500 characters. 603's remark runs to character 295,
  // so the cut keeps the name (470) but not the function (517), the birth place (516), its country or the citizenship.
  const cut = run("grep -n -F -e ';603;' lists/eu.txt | cut -c1-500 | head -n 20", dir);
  assert.match(cut, /Mohammad Hassan Akhund/);
  assert.doesNotMatch(cut, /Pashmul|First Deputy|;AF;/);
  const out = run(ruled("grep -F -e 'Entity_LogicalId'").replaceAll("<id>", "603"), dir).replace(/\r/g, "").trim().split("\n");
  const header = out[0].split(";");
  const rows = out.slice(1).map((line) => Object.fromEntries(line.split(";").map((v, i) => [header[i], v])));
  assert.equal(header[0], "Entity_LogicalId", "the header line comes first and names each column");
  assert.equal(rows.length, 4, "every row of the entity, and no other");
  assert.ok(rows.every((r) => r.Entity_LogicalId === "603"));
  const values = (column) => rows.map((r) => r[column]).filter(Boolean);
  assert.deepEqual(values("NameAlias_WholeName"), ["Mohammad Hassan Akhund"]);
  assert.match(values("NameAlias_Function")[0], /^\(a\) First Deputy, Council of Ministers under the Taliban regime/);
  assert.deepEqual(values("BirthDate_City"), ["Pashmul village, Panjwai District, Kandahar Province", "Pashmul village, Panjwai District, Kandahar Province"]);
  assert.deepEqual(values("BirthDate_YearRangeFrom"), ["1955", "1945"]);
  assert.deepEqual(values("Citizenship_CountryIso2Code"), ["AF"]);
  for (const column of ["Entity_EU_ReferenceNumber", "Entity_Remark", "Entity_SubjectType", "Entity_Regulation_Programme", "Identification_Number", "Identification_TypeDescription", "Address_CountryDescription"]) {
    assert.ok(header.includes(column), `the read names ${column}`);
  }
  // If the file's columns ever move, the rule numbers them from the header.
  assert.match(run(ruled("head -n 1 lists/eu.txt"), dir), /^\s*20\s+NameAlias_WholeName$/m);
});
