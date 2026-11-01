// Builds the five decision-demo workflows (workflows/*.json) and their inputs (inputs/*.json) from one place, so the
// question wording, thresholds and schemas stay the same across use cases. Run: node examples/decision-demos/build.mjs
// The JSON files are what the runner and the console load; edit here and rebuild, or edit the JSON in the console.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const labels = JSON.parse(readFileSync(`${here}documents/labels.json`, "utf8"));
const AS_OF = labels.as_of;

// ---------------------------------------------------------------- shared schemas

const PdfPages = {
  type: "object", required: ["name", "pageCount", "pages", "text"],
  properties: {
    name: { type: "string" }, pageCount: { type: "integer" }, text: { type: "string" },
    pages: { type: "array", items: { type: "object", required: ["page", "image"], properties: { page: { type: "integer" }, image: { type: "string" } } } },
  },
};
const LlmResult = {
  type: "object", required: ["text"],
  properties: { text: { type: "string" }, model: { type: ["string", "null"] }, usage: { type: ["object", "null"] }, cost_usd: { type: ["number", "null"] } },
};
const Page = {
  type: "object", required: ["ok", "url", "status", "title", "text", "links"],
  properties: { ok: { type: "boolean" }, url: { type: "string" }, status: { type: "integer" }, title: { type: "string" }, text: { type: "string" }, links: { type: "array", items: { type: "string" } }, refused: { type: "string" }, error: { type: "string" } },
};
const Documents = { type: "array", minItems: 1, items: { type: "string", minLength: 1 } };
const AsOf = { type: "string", description: "The review date (YYYY-MM-DD): a filing date after it is in the future." };

/** One `pdf_pages` call: page 1 of `path` as an image, plus the text layer. */
const renderPages = (label, path, as = "pages") => ({
  node: "call", label, via: "tool", tool: "pdf_pages", args: { path, maxPages: 1, dpi: 110 }, out: "PdfPages", as, deadline_s: 60,
});

// ---------------------------------------------------------------- the visual checks (use cases 1 and 2)

// Each question is asked of one page image. Their thresholds are set per question, with the band between pass and fail
// sent to a second look. The pass lines sit in the gaps the first live run showed (Jev 1.14, 2026-10-30, these 20
// pages): "looks altered" read 0.08-0.50 on clean pages and 0.93-0.99 on altered ones, so it passes below 0.6 (was 0.3)
// and fails at 0.8; "name consistent" and "date not future" read 0.74 and up on clean pages and 0.01 on the pages with
// those defects, so they pass at 0.7 (was 0.8).
const Q = {
  is_certificate: "Is the document in <page_1> a certificate of incorporation or articles of incorporation filed with a US state's filing office (not an IRS letter, a bank letter or another kind of document)?",
  looks_altered: "Does <page_1> show signs that someone edited the document after it was issued: a field covered over or pasted on, a date typed over another, a box with a visible edge or shadow, or a value misaligned or in a different typeface from the text around it?",
  seal_present: "Does <page_1> carry the filing office's seal or its certification stamp where the form places one?",
  signature_present: "Is there a signature (handwritten or script) on every signature line in <page_1>?",
  name_consistent: "Is the company's name legible, and is it the same name (same words, same suffix such as Inc., LLC or Corp.) everywhere it appears in <page_1>: heading, body and certification?",
  date_not_future: "Is every filing, notice or execution date shown in <page_1> on or before the date in `as_of`?",
  // One property per question: live (2026-10-30), a question that bundled the issuer's marks with the signatures passed
  // an unsigned certificate on its seal (0.93). A separate typeface question did not help: clean pages read 0.21-0.78 on
  // it and the one page with a swapped typeface 0.35, so it is not asked.
  issuer_marks: "Does <page_1> carry the issuer's marks for a document of its kind: for a certificate or articles of incorporation, the filing office's seal or certification stamp; for a bank letter, the bank's letterhead; for an IRS EIN notice (CP 575), the IRS header and the notice number?",
  signed: "Is every signature line in <page_1> signed with a handwritten or script signature? A document with no signature lines, such as an IRS EIN notice (CP 575), counts as yes.",
};
const yes = (q, extra = {}) => ({ type: "boolean", description: Q[q], ...extra });
const DocType = {
  type: "string", enum: ["certificate_of_incorporation", "ein_letter", "bank_letter", "other"],
  description: "What kind of document is shown in <page_1>?",
  criteria: {
    certificate_of_incorporation: "A certificate or articles of incorporation (or formation) filed with a US state's filing office.",
    ein_letter: "An IRS notice assigning an Employer Identification Number (CP 575 or similar).",
    bank_letter: "A bank's letter confirming a business account (account verification or reference letter).",
    other: "Any other document, or a page that cannot be read.",
  },
};
// want: which answer is the good one. pass: the side of this a clean document must reach. fail: past this, it fails
// outright. Between the two the check is unsure and the document gets a second look.
const T_CERT = {
  is_certificate: { want: "yes", pass: 0.8, fail: 0.2, label: "not a certificate of incorporation" },
  looks_altered: { want: "no", pass: 0.6, fail: 0.8, label: "looks altered" },
  seal_present: { want: "yes", pass: 0.7, fail: 0.25, label: "no seal or certification stamp" },
  signature_present: { want: "yes", pass: 0.7, fail: 0.25, label: "a signature is missing" },
  name_consistent: { want: "yes", pass: 0.7, fail: 0.3, label: "the company name differs between places" },
  date_not_future: { want: "yes", pass: 0.7, fail: 0.3, label: "a date is in the future" },
};
const T_ANY = {
  looks_altered: T_CERT.looks_altered,
  issuer_marks: { want: "yes", pass: 0.7, fail: 0.25, label: "missing the issuer's seal, stamp or header" },
  signed: { want: "yes", pass: 0.7, fail: 0.25, label: "a signature line is not signed" },
  name_consistent: T_CERT.name_consistent,
  date_not_future: T_CERT.date_not_future,
};

/** A code node applying thresholds table `T` to the raw yes-probabilities at `<key>$answers`: pass, fail or borderline. */
const triageCode = (key, T, extra = "") => `(s) => {
  const T = ${JSON.stringify(T)};
  const raw = (s[${JSON.stringify(`${key}$answers`)}] || {}).answers || {};
  const p = {}; const failed = []; const unsure = [];
  for (const q of Object.keys(T)) {
    const t = T[q];
    const v = raw[q] && typeof raw[q].noul === "number" ? raw[q].noul : null;
    p[q] = v;
    if (v === null) { unsure.push(q + ": no probability came back"); continue; }
    const good = t.want === "yes" ? v >= t.pass : v < t.pass;
    const bad = t.want === "yes" ? v < t.fail : v >= t.fail;
    if (bad) failed.push(t.label + " (" + q + " " + v.toFixed(2) + ")");
    else if (!good) unsure.push(q + " is unclear (P(yes) " + v.toFixed(2) + ")");
  }
  ${extra}
  return { action: failed.length ? "fail" : unsure.length ? "borderline" : "pass", failed, unsure, unsure_text: unsure.join("; "), p };
}`;

/** The second look a borderline document gets: Jev sees the page again, with the checks that were unclear, and says
 *  valid or doubtful. Below the confidence gate it is doubtful: a person looks. */
const secondLook = (validBody, doubtfulBody) => ({
  node: "route", label: "second_look", provider: "jev", timeoutMs: 60000,
  images: { "<page_1>": "{pages.pages.0.image}" },
  state: { file: "{pages.name}", page_image: "<page_1>", as_of: "{as_of}", unclear_checks: "{triage.unsure}" },
  instructions: "A first pass could not settle the checks in `unclear_checks`. Looking at <page_1> again with those in mind: is this document genuine, complete and unaltered, so that it can be accepted as issued, as of `as_of`?",
  branches: {
    valid: { criteria: "Genuine, complete and unaltered: nothing on the page contradicts that it was issued as shown.", body: validBody },
    doubtful: { criteria: "Something on the page is wrong, missing or cannot be confirmed from the image.", body: doubtfulBody },
  },
  unsure: { branch: "doubtful", gte: 0.75 },
  as: "second_look",
});

const verdictCode = (verdict, by) => `(s) => ({ status: ${JSON.stringify(verdict)}, by: ${JSON.stringify(by)} })`;

// ---------------------------------------------------------------- 1. doc-valid

const docValid = {
  v: 2, name: "doc-valid",
  schemas: {
    Input: { type: "object", required: ["documents", "as_of"], properties: { documents: { ...Documents, maxItems: 1, description: "One certificate of incorporation, a file name under the run's documents." }, as_of: AsOf } },
    PdfPages,
    CertificateChecks: { type: "object", additionalProperties: false, required: Object.keys(T_CERT), properties: Object.fromEntries(Object.keys(T_CERT).map((q) => [q, yes(q)])) },
    Decision: {
      type: "object", required: ["document", "verdict", "decided_by", "reasons", "probabilities"],
      properties: {
        document: { type: "string" }, verdict: { type: "string", enum: ["valid", "invalid"] }, decided_by: { type: "string" },
        reasons: { type: "array", items: { type: "string" } }, probabilities: { type: "object" },
      },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Decision", path: "decision" },
  root: {
    node: "chain",
    steps: [
      renderPages("render_page", "{documents.0}"),
      {
        node: "judge", label: "inspect_certificate", provider: "jev", timeoutMs: 60000,
        images: { "<page_1>": "{pages.pages.0.image}" },
        state: { file: "{pages.name}", page_image: "<page_1>", as_of: "{as_of}", text_layer: "{pages.text}" },
        out: "CertificateChecks", as: "checks",
      },
      { node: "code", label: "apply_thresholds", as: "triage", code: triageCode("checks", T_CERT) },
      {
        node: "route", label: "triage_route", valuePath: "triage.action", as: "triage_taken",
        branches: {
          pass: { body: { node: "code", label: "accept", as: "verdict", code: verdictCode("valid", "thresholds") } },
          fail: { body: { node: "code", label: "reject", as: "verdict", code: verdictCode("invalid", "thresholds") } },
          borderline: {
            body: secondLook(
              { node: "code", label: "accept_on_second_look", as: "verdict", code: verdictCode("valid", "second_look") },
              { node: "escalate", label: "send_to_review", when: { predicate: "field_equals", path: "second_look.taken", value: "doubtful" }, kind: "document_review", stage: "doc-valid", summary: "A person reviews {pages.name}: the first pass was unsure ({triage.unsure_text}) and the second look did not clear it." },
            ),
          },
        },
      },
      {
        node: "code", label: "decide", as: "decision",
        code: `(s) => ({ document: s.pages.name, verdict: s.verdict.status, decided_by: s.verdict.by, reasons: s.verdict.status === "valid" ? [] : s.triage.failed, probabilities: s.triage.p })`,
      },
    ],
  },
};

// ---------------------------------------------------------------- 2. batch-20

const reviewBody = {
  node: "chain",
  steps: [
    renderPages("render_page", "{item}"),
    {
      node: "judge", label: "inspect_document", provider: "jev", timeoutMs: 60000,
      images: { "<page_1>": "{pages.pages.0.image}" },
      state: { file: "{pages.name}", page_image: "<page_1>", as_of: "{as_of}", text_layer: "{pages.text}" },
      out: "DocumentChecks", as: "checks",
    },
    {
      node: "code", label: "apply_thresholds", as: "triage",
      code: triageCode("checks", T_ANY, `const kind = (s.checks || {}).doc_type;
  if (kind === "other") failed.push("not a certificate, EIN notice or bank letter");`),
    },
    {
      node: "route", label: "triage_route", valuePath: "triage.action", as: "triage_taken",
      branches: {
        pass: { body: { node: "code", label: "accept", as: "verdict", code: verdictCode("valid", "thresholds") } },
        fail: { body: { node: "code", label: "reject", as: "verdict", code: verdictCode("invalid", "thresholds") } },
        borderline: {
          body: secondLook(
            { node: "code", label: "accept_on_second_look", as: "verdict", code: verdictCode("valid", "second_look") },
            { node: "code", label: "hold_for_review", as: "verdict", code: verdictCode("review", "second_look") },
          ),
        },
      },
    },
    {
      node: "code", label: "record", as: "review",
      code: `(s) => ({ document: s.item, doc_type: s.checks.doc_type, verdict: s.verdict.status, decided_by: s.verdict.by,
  reasons: s.verdict.status === "invalid" ? s.triage.failed : s.verdict.status === "review" ? s.triage.unsure : [],
  probabilities: s.triage.p,
  second_look: s.second_look ? { taken: s.second_look.taken, unsure: s.second_look.unsure } : null })`,
    },
  ],
};

const templateReport = `(s) => {
  const rows = s.reviews.filter((r) => r);
  const mark = { valid: "VALID", invalid: "INVALID", review: "REVIEW" };
  const kind = { certificate_of_incorporation: "Certificate of incorporation", ein_letter: "IRS EIN notice", bank_letter: "Bank letter", other: "Other" };
  const lines = [];
  lines.push("# Document review: " + rows.length + " of " + s.documents.length + " documents read");
  lines.push("");
  lines.push("As of " + s.as_of + ". Valid " + s.tally.valid + ", invalid " + s.tally.invalid + ", sent to review " + s.tally.review + ", unreadable " + s.tally.unreadable + ".");
  lines.push("");
  lines.push("| # | Document | Kind | Verdict | Decided by | Why |");
  lines.push("|---|---|---|---|---|---|");
  rows.forEach((r, i) => lines.push("| " + (i + 1) + " | " + r.document + " | " + (kind[r.doc_type] || r.doc_type) + " | " + mark[r.verdict] + " | " + r.decided_by + " | " + (r.reasons.join("; ") || "all checks passed") + " |"));
  for (const f of s.unreadable || []) lines.push("| - | " + s.documents[f.item_index] + " | - | UNREADABLE | " + f.label + " | " + f.message + " |");
  return lines.join("\\n");
}`;

const llmPrompt = `(s) => {
  const rows = s.reviews.filter((r) => r).map((r) => ({ document: r.document, kind: r.doc_type, verdict: r.verdict, decided_by: r.decided_by, reasons: r.reasons, probabilities: r.probabilities }));
  return [
    "DOCUMENT REVIEW REPORT REQUEST",
    "Review date: " + s.as_of,
    "Totals: " + JSON.stringify(s.tally),
    "Write the report document by document, in the order given. For each document: one heading with its file name, its verdict in capitals (VALID, INVALID or REVIEW), and two or three plain sentences saying what the checks found and what a reviewer should do next. Quote probabilities as given; do not invent findings that are not in the record. End with a short summary paragraph.",
    "RECORDS (JSON):",
    JSON.stringify(rows),
    "UNREADABLE (JSON):",
    JSON.stringify((s.unreadable || []).map((f) => ({ document: s.documents[f.item_index], step: f.label, error: f.message }))),
  ].join("\\n");
}`;

const batch20 = {
  v: 2, name: "batch-20",
  schemas: {
    Input: { type: "object", required: ["documents", "as_of"], properties: { documents: { ...Documents, description: "The documents to review, file names under the run's documents." }, as_of: AsOf } },
    PdfPages, LlmResult,
    DocumentChecks: {
      type: "object", additionalProperties: false, required: ["doc_type", ...Object.keys(T_ANY)],
      properties: { doc_type: DocType, ...Object.fromEntries(Object.keys(T_ANY).map((q) => [q, yes(q)])) },
    },
    Review: {
      type: "object", required: ["document", "doc_type", "verdict", "decided_by", "reasons", "probabilities"],
      properties: {
        document: { type: "string" }, doc_type: { type: "string" }, verdict: { type: "string", enum: ["valid", "invalid", "review"] }, decided_by: { type: "string" },
        reasons: { type: "array", items: { type: "string" } }, probabilities: { type: "object" }, second_look: { type: ["object", "null"] },
      },
    },
    Result: {
      type: "object", required: ["tally", "reviews", "report_template", "report_llm"],
      properties: {
        tally: { type: "object" }, reviews: { type: "array", items: { anyOf: [{ $ref: "#/definitions/Review" }, { type: "null" }] } },
        unreadable: { type: "array" }, report_template: { type: "string" }, report_llm: { type: "string" },
        report_llm_model: { type: ["string", "null"] }, report_llm_cost_usd: { type: ["number", "null"] },
      },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Result", path: "result" },
  root: {
    node: "chain",
    steps: [
      { node: "map", label: "review_documents", itemsPath: "documents", maxConcurrency: 4, onItemFailure: "collect", failedAs: "unreadable", resultPath: "review", as: "reviews", body: reviewBody },
      {
        node: "code", label: "tally", as: "tally",
        code: `(s) => { const rows = s.reviews.filter((r) => r); const n = (v) => rows.filter((r) => r.verdict === v).length;
  return { total: s.documents.length, valid: n("valid"), invalid: n("invalid"), review: n("review"), unreadable: (s.unreadable || []).length }; }`,
      },
      {
        node: "parallel", label: "write_reports",
        branches: [
          { node: "code", label: "template_report", as: "report_template", code: templateReport },
          {
            node: "chain",
            steps: [
              { node: "code", label: "llm_prompt", as: "llm_prompt", code: llmPrompt },
              {
                node: "call", label: "llm_report", via: "tool", tool: "llm", deadline_s: 180, out: "LlmResult", as: "report_llm",
                args: { prompt: "{llm_prompt}", system: "You write document review reports for a KYB analyst. Plain, short, factual. Markdown.", maxTokens: 4000 },
              },
            ],
          },
        ],
      },
      {
        node: "code", label: "deliver", as: "result",
        code: `(s) => ({ tally: s.tally, reviews: s.reviews, unreadable: s.unreadable || [], report_template: s.report_template, report_llm: s.report_llm.text,
  report_llm_model: s.report_llm.model === undefined ? null : s.report_llm.model, report_llm_cost_usd: s.report_llm.cost_usd === undefined ? null : s.report_llm.cost_usd })`,
      },
    ],
  },
};

// ---------------------------------------------------------------- 3. kyb

const PACKET_IMAGES = { "<coi_page>": "{packet.0.pages.0.image}", "<ein_page>": "{packet.1.pages.0.image}", "<bank_page>": "{packet.2.pages.0.image}" };
const PACKET_STATE = {
  company: "{company}", as_of: "{as_of}",
  certificate: { file: "{packet.0.name}", page: "<coi_page>" },
  ein_notice: { file: "{packet.1.name}", page: "<ein_page>" },
  bank_letter: { file: "{packet.2.name}", page: "<bank_page>" },
};
const T_KYB = {
  documents: {
    coi_altered: { want: "no", pass: 0.6, fail: 0.8, label: "the certificate looks altered" },
    ein_altered: { want: "no", pass: 0.6, fail: 0.8, label: "the EIN notice looks altered" },
    bank_altered: { want: "no", pass: 0.6, fail: 0.8, label: "the bank letter looks altered" },
    coi_sealed: { want: "yes", pass: 0.7, fail: 0.25, label: "the certificate lacks the filing office's seal or stamp" },
    coi_signed: { want: "yes", pass: 0.7, fail: 0.25, label: "a signature line on the certificate is not signed" },
    bank_signed: { want: "yes", pass: 0.7, fail: 0.25, label: "the bank letter is not signed" },
  },
  cross: {
    same_entity: { want: "yes", pass: 0.8, fail: 0.5, label: "the documents name different entities" },
    same_state: { want: "yes", pass: 0.8, fail: 0.5, label: "the state of incorporation does not match" },
    dates_consistent: { want: "yes", pass: 0.75, fail: 0.4, label: "the dates are out of order" },
  },
};

const kybDecision = `(s) => {
  const T = ${JSON.stringify(T_KYB)};
  const reject = []; const review = []; const p = {};
  for (const key of ["documents", "cross"]) {
    const raw = (s[key + "$answers"] || {}).answers || {};
    for (const q of Object.keys(T[key])) {
      const t = T[key][q];
      const v = raw[q] && typeof raw[q].noul === "number" ? raw[q].noul : null;
      p[q] = v;
      if (v === null) { review.push(q + ": no probability came back"); continue; }
      const good = t.want === "yes" ? v >= t.pass : v < t.pass;
      const bad = t.want === "yes" ? v < t.fail : v >= t.fail;
      // A forged-looking document is a reject; a mismatch between documents is a question for a person.
      if (bad && key === "documents") reject.push(t.label + " (P(yes) " + v.toFixed(2) + ")");
      else if (bad || !good) review.push(t.label + " (P(yes) " + v.toFixed(2) + ")");
    }
  }
  const reg = s.registry || {};
  const regRaw = ((s["registry$answers"] || {}).answers || {}).registry_status || {};
  p.registry_status = regRaw.choice || null; p.registry_confidence = typeof regRaw.confidence === "number" ? regRaw.confidence : null;
  p.name_exact = (((s["registry$answers"] || {}).answers || {}).name_exact || {}).noul;
  if (reg.registry_status === "not_found" && p.registry_confidence !== null && p.registry_confidence >= 0.7) reject.push("no registry record for the company");
  else if (reg.registry_status !== "active") review.push("registry status is " + (reg.registry_status || "unknown"));
  if (typeof p.name_exact === "number" && p.name_exact < 0.7) review.push("the registry name is not an exact match (P(yes) " + p.name_exact.toFixed(2) + ")");
  const evidence = ((s["registry$answers"] || {}).evidence || []).map((e) => ({ url: e.url, title: e.title }));
  const action = reject.length ? "reject" : review.length ? "review" : "approve";
  return { action, reasons: reject.concat(review), probabilities: p, evidence, summary: action + ": " + (reject.concat(review).join("; ") || "every check passed") };
}`;

const kyb = {
  v: 2, name: "kyb",
  schemas: {
    Input: {
      type: "object", required: ["company", "jurisdiction", "documents", "as_of"],
      properties: {
        company: { type: "string", minLength: 1, description: "The legal name the applicant gave." },
        jurisdiction: { type: "string", minLength: 1, description: "The US state the applicant says the company is incorporated in." },
        documents: { ...Documents, minItems: 3, maxItems: 3, description: "In order: certificate of incorporation, IRS EIN notice, bank letter." },
        as_of: AsOf,
      },
    },
    PdfPages,
    RegistryStatus: {
      type: "object", additionalProperties: false, required: ["registry_status", "name_exact"],
      properties: {
        registry_status: {
          type: "string", enum: ["active", "inactive", "registered_elsewhere", "not_found"],
          description: "Is a company with the name in `company` registered with the state filing office of `jurisdiction`, and in good standing?",
          criteria: {
            active: "The state's registry lists the company, and it is active or in good standing.",
            inactive: "The state's registry lists the company, but it is dissolved, forfeited, revoked or otherwise not in good standing.",
            registered_elsewhere: "Public records show the company registered, but only in another state.",
            not_found: "Public sources do not establish that a company with this name is registered.",
          },
        },
        name_exact: { type: "boolean", description: "Does the registry record carry exactly the name in `company`, including its suffix (Inc., LLC, Corp.)?" },
      },
    },
    PacketChecks: {
      type: "object", additionalProperties: false, required: Object.keys(T_KYB.documents),
      properties: {
        coi_altered: { type: "boolean", description: "Does the certificate in <coi_page> show signs of editing after issue: a field covered or pasted over, a retyped date, a value in a different typeface or misaligned?" },
        ein_altered: { type: "boolean", description: "Does the IRS EIN notice in <ein_page> show signs of editing after issue: a field covered or pasted over, a retyped date, a value in a different typeface or misaligned?" },
        bank_altered: { type: "boolean", description: "Does the bank letter in <bank_page> show signs of editing after issue: a field covered or pasted over, a retyped date, a value in a different typeface or misaligned?" },
        coi_sealed: { type: "boolean", description: "Does the certificate in <coi_page> carry the filing office's seal or its certification stamp where the form places one?" },
        coi_signed: { type: "boolean", description: "Is there a signature (handwritten or script) on every signature line of the certificate in <coi_page>?" },
        bank_signed: { type: "boolean", description: "Is the bank letter in <bank_page> signed by a named bank officer?" },
      },
    },
    CrossCheck: {
      type: "object", additionalProperties: false, required: Object.keys(T_KYB.cross),
      properties: {
        same_entity: { type: "boolean", description: "Do the certificate (<coi_page>), the EIN notice (<ein_page>) and the bank letter (<bank_page>) all name the same legal entity as `company`: the same words and the same suffix?" },
        same_state: { type: "boolean", description: "Is the state of incorporation on the certificate (<coi_page>) the same as `jurisdiction`?" },
        dates_consistent: { type: "boolean", description: "Are the dates in order: the certificate's filing date (<coi_page>) on or before the EIN notice date (<ein_page>), and both on or before the bank account's opening date (<bank_page>), all on or before `as_of`?" },
      },
    },
    KybDecision: {
      type: "object", required: ["company", "decision", "reasons", "probabilities", "evidence"],
      properties: {
        company: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] }, reasons: { type: "array", items: { type: "string" } },
        probabilities: { type: "object" }, evidence: { type: "array" },
      },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "KybDecision", path: "decision" },
  root: {
    node: "chain",
    steps: [
      { node: "map", label: "render_packet", itemsPath: "documents", maxConcurrency: 3, resultPath: "pages", as: "packet", body: renderPages("render_page", "{item}") },
      {
        node: "parallel", label: "checks",
        branches: [
          {
            node: "judge", label: "registry_check", provider: "parallel", evidence: "if_supported", timeoutMs: 120000,
            state: { company: "{company}", jurisdiction: "{jurisdiction}" }, out: "RegistryStatus", as: "registry",
          },
          {
            node: "judge", label: "document_checks", provider: "jev", timeoutMs: 60000,
            images: PACKET_IMAGES, state: PACKET_STATE, out: "PacketChecks", as: "documents",
          },
        ],
      },
      {
        node: "judge", label: "cross_check", provider: "jev", timeoutMs: 60000,
        images: PACKET_IMAGES,
        state: { ...PACKET_STATE, jurisdiction: "{jurisdiction}", registry: "{registry}" },
        out: "CrossCheck", as: "cross",
      },
      { node: "code", label: "kyb_rule", as: "kyb", code: kybDecision },
      {
        node: "route", label: "kyb_route", valuePath: "kyb.action", as: "kyb_taken",
        branches: {
          approve: { body: { node: "code", label: "approve", as: "decision", code: `(s) => ({ company: s.company, decision: "approve", reasons: [], probabilities: s.kyb.probabilities, evidence: s.kyb.evidence })` } },
          reject: { body: { node: "code", label: "reject", as: "decision", code: `(s) => ({ company: s.company, decision: "reject", reasons: s.kyb.reasons, probabilities: s.kyb.probabilities, evidence: s.kyb.evidence })` } },
          review: { body: { node: "escalate", label: "send_to_review", when: { predicate: "field_equals", path: "kyb.action", value: "review" }, kind: "kyb_review", stage: "kyb", summary: "A person reviews {company}: {kyb.summary}" } },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------- 4. merchant-mcc

const MCC = [
  ["5411", "Grocery stores and supermarkets"], ["5499", "Miscellaneous food stores: specialty foods, coffee, tea, confectionery"],
  ["5812", "Eating places and restaurants"], ["5814", "Fast food restaurants"], ["5651", "Family clothing stores"],
  ["5661", "Shoe stores"], ["5948", "Luggage and leather goods stores, including handbags"], ["5944", "Jewelry, watch and clock stores"],
  ["5732", "Electronics stores"], ["5734", "Computer software stores"], ["5942", "Book stores"], ["5945", "Hobby, toy and game shops"],
  ["5977", "Cosmetic stores"], ["5912", "Drug stores and pharmacies"], ["5993", "Cigar stores and stands, including vape and smoke shops"],
  ["5999", "Miscellaneous and specialty retail stores"], ["5921", "Package stores: beer, wine and liquor"],
  ["5967", "Direct marketing: inbound teleservices and adult content"], ["7995", "Betting, including lottery tickets, casino chips and off-track betting"],
  ["4829", "Money transfer"], ["6051", "Quasi-cash: crypto assets, money orders, foreign currency"], ["7372", "Computer programming and software services"],
  ["8099", "Medical and health services, not elsewhere classified"], ["7299", "Miscellaneous personal services"],
];
const HIGH_RISK_MCC = ["5967", "7995", "4829", "6051", "5993", "5912", "5122"];

const merchantRisk = `(s) => {
  const HIGH_RISK_MCC = ${JSON.stringify(HIGH_RISK_MCC)};
  const reasons = []; const p = {};
  const sig = (s["page_signals$answers"] || {}).answers || {};
  const web = (s["web$answers"] || {}).answers || {};
  p.page_prohibited = sig.advertises_prohibited ? sig.advertises_prohibited.noul : null;
  p.page_restricted = sig.advertises_restricted ? sig.advertises_restricted.noul : null;
  p.web_prohibited = web.sells_prohibited ? web.sells_prohibited.noul : null;
  p.web_risk = web.risk_level ? web.risk_level.choice : null;
  p.web_risk_confidence = web.risk_level && typeof web.risk_level.confidence === "number" ? web.risk_level.confidence : null;
  const code = s.mcc && s.mcc.item ? s.mcc.item.code : null;
  let tier = "low";
  const raise = (t, why) => { reasons.push(why); if (t === "high" || (t === "medium" && tier === "low")) tier = t; };
  if (p.page_prohibited === null || p.web_prohibited === null) raise("medium", "a prohibited-goods answer is missing");
  if (p.page_prohibited !== null && p.page_prohibited >= 0.8) raise("high", "the page offers prohibited goods (P(yes) " + p.page_prohibited.toFixed(2) + ")");
  else if (p.page_prohibited !== null && p.page_prohibited >= 0.35) raise("medium", "the page may offer prohibited goods (P(yes) " + p.page_prohibited.toFixed(2) + ")");
  if (p.web_prohibited !== null && p.web_prohibited >= 0.8) raise("high", "public sources say it sells prohibited goods (P(yes) " + p.web_prohibited.toFixed(2) + ")");
  else if (p.web_prohibited !== null && p.web_prohibited >= 0.35) raise("medium", "public sources are mixed on prohibited goods (P(yes) " + p.web_prohibited.toFixed(2) + ")");
  if (p.page_restricted !== null && p.page_restricted >= 0.6) raise("medium", "the page offers restricted products (P(yes) " + p.page_restricted.toFixed(2) + ")");
  if (p.web_risk === "high") raise("high", "public sources rate the merchant high risk");
  else if (p.web_risk === "elevated") raise("medium", "public sources rate the merchant elevated risk");
  if (!code) raise("medium", "no merchant category code fits");
  else if (HIGH_RISK_MCC.includes(code)) raise("medium", "MCC " + code + " is a high-risk category");
  const evidence = ((s["web$answers"] || {}).evidence || []).map((e) => ({ url: e.url, title: e.title }));
  return { tier, mcc: code, mcc_label: s.mcc ? s.mcc.option : null, reasons, reasons_text: reasons.join("; "), probabilities: p, evidence };
}`;

const merchantMcc = {
  v: 2, name: "merchant-mcc",
  schemas: {
    Input: { type: "object", required: ["merchant_name", "url"], properties: { merchant_name: { type: "string", minLength: 1 }, url: { type: "string", minLength: 1, description: "The merchant's public home page." } } },
    Page,
    PageSignals: {
      type: "object", additionalProperties: false, required: ["advertises_prohibited", "advertises_restricted"],
      properties: {
        advertises_prohibited: { type: "boolean", description: "Does the page in `page_text` offer goods or services card networks prohibit: counterfeit, replica or 'mirror quality' branded goods, illegal drugs or drug paraphernalia, weapons that are illegal to sell, or unlicensed gambling?" },
        advertises_restricted: { type: "boolean", description: "Does the page in `page_text` offer products card networks restrict and acquirers onboard only with extra checks: CBD or hemp products, vaping products, nutraceuticals with health claims, firearms accessories, alcohol or tobacco?" },
      },
    },
    WebRisk: {
      type: "object", additionalProperties: false, required: ["sells_prohibited", "risk_level"],
      properties: {
        sells_prohibited: { type: "boolean", description: "According to public sources about the merchant in `merchant_name` at `url` (reviews, complaints, news, marketplace listings), does it sell goods or services card networks prohibit, such as counterfeit or replica branded goods or illegal drugs?" },
        risk_level: {
          type: "string", enum: ["low", "elevated", "high"],
          description: "How risky is it for a card acquirer to process payments for the merchant in `merchant_name` at `url`, judging from public sources?",
          criteria: {
            low: "An ordinary merchant: no complaints pattern, no prohibited or restricted goods.",
            elevated: "Restricted goods, a pattern of chargeback or delivery complaints, or a thin public footprint.",
            high: "Prohibited goods, fraud reports, or enforcement actions.",
          },
        },
      },
    },
    MerchantDecision: {
      type: "object", required: ["merchant_name", "decision", "tier", "mcc", "reasons"],
      properties: { merchant_name: { type: "string" }, decision: { type: "string", enum: ["approve", "decline"] }, tier: { type: "string" }, mcc: { type: ["string", "null"] }, mcc_label: { type: ["string", "null"] }, reasons: { type: "array", items: { type: "string" } }, probabilities: { type: "object" }, evidence: { type: "array" } },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "MerchantDecision", path: "decision" },
  root: {
    node: "chain",
    steps: [
      { node: "call", label: "fetch_site", via: "tool", tool: "fetch_page", args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 45 },
      { node: "escalate", label: "site_unreadable", when: { predicate: "field_equals", path: "page.ok", value: false }, kind: "merchant_review", stage: "merchant-mcc", summary: "A person reviews {merchant_name}: its page at {url} could not be read." },
      { node: "code", label: "mcc_candidates", as: "mcc_codes", code: `(s) => ${JSON.stringify(MCC.map(([code, description]) => ({ code, description })))}` },
      {
        node: "parallel", label: "read_the_page",
        branches: [
          {
            node: "pick", label: "choose_mcc", provider: "jev", timeoutMs: 60000, itemsPath: "mcc_codes", describe: "{item.code}: {item.description}", allowNone: true,
            instructions: "Which merchant category code best describes what this merchant sells, judging from its own web page?",
            state: { merchant: "{merchant_name}", page_title: "{page.title}", page_text: "{page.text}" }, as: "mcc",
          },
          {
            node: "judge", label: "page_signals", provider: "jev", timeoutMs: 60000,
            state: { merchant: "{merchant_name}", page_title: "{page.title}", page_text: "{page.text}" }, out: "PageSignals", as: "page_signals",
          },
        ],
      },
      {
        node: "judge", label: "web_check", provider: "parallel", evidence: "if_supported", timeoutMs: 120000,
        state: { merchant_name: "{merchant_name}", url: "{url}", category: "{mcc.option}" }, out: "WebRisk", as: "web",
      },
      { node: "code", label: "risk_tier", as: "risk", code: merchantRisk },
      {
        node: "route", label: "risk_route", valuePath: "risk.tier", as: "risk_taken",
        branches: {
          low: { body: { node: "code", label: "approve", as: "decision", code: `(s) => ({ merchant_name: s.merchant_name, decision: "approve", tier: "low", mcc: s.risk.mcc, mcc_label: s.risk.mcc_label, reasons: s.risk.reasons, probabilities: s.risk.probabilities, evidence: s.risk.evidence })` } },
          medium: { body: { node: "escalate", label: "enhanced_due_diligence", when: { predicate: "field_equals", path: "risk.tier", value: "medium" }, kind: "merchant_review", stage: "merchant-mcc", summary: "Enhanced due diligence for {merchant_name} (MCC {risk.mcc}): {risk.reasons_text}" } },
          high: { body: { node: "code", label: "decline", as: "decision", code: `(s) => ({ merchant_name: s.merchant_name, decision: "decline", tier: "high", mcc: s.risk.mcc, mcc_label: s.risk.mcc_label, reasons: s.risk.reasons, probabilities: s.risk.probabilities, evidence: s.risk.evidence })` } },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------- 5. jury

const JURORS = [
  { label: "jev", provider: "jev", as: "vote_jev" },
  { label: "pplx_decider", provider: "openrouter", model: "perplexity/pplx-decider-v1.2", as: "vote_pplx" },
  { label: "liquid_d1", provider: "openrouter", model: "liquid/d1", as: "vote_liquid" },
  { label: "cloudflare_clef", provider: "openrouter", model: "cloudflare/clef", as: "vote_clef" },
];

const aggregate = `(s) => {
  const jurors = ${JSON.stringify(JURORS.map(({ label, as, model, provider }) => ({ label, as, model: model || provider })))};
  const votes = jurors.map((j) => { const a = ((s[j.as + "$answers"] || {}).answers || {}).is_gambling; return { juror: j.label, model: j.model, p: a && typeof a.noul === "number" ? a.noul : null }; });
  const ps = votes.map((v) => v.p).filter((p) => p !== null);
  const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
  const spread = ps.length ? Math.max(...ps) - Math.min(...ps) : null;
  const sd = ps.length ? Math.sqrt(ps.reduce((a, p) => a + (p - mean) * (p - mean), 0) / ps.length) : null;
  // Agree: every juror answered, they sit within 0.35 of each other, and the mean is clear of the middle band.
  let action = "human_review"; let why;
  if (ps.length < jurors.length) why = (jurors.length - ps.length) + " juror(s) gave no probability";
  else if (spread > 0.35) why = "the jurors disagree (spread " + spread.toFixed(2) + ")";
  else if (mean >= 0.7) { action = "auto_yes"; why = "the jurors agree it is gambling (mean " + mean.toFixed(2) + ")"; }
  else if (mean < 0.3) { action = "auto_no"; why = "the jurors agree it is not gambling (mean " + mean.toFixed(2) + ")"; }
  else why = "the jurors agree it is unclear (mean " + mean.toFixed(2) + ")";
  return { action, why, mean, spread, stdev: sd, votes };
}`;

const jury = {
  v: 2, name: "jury",
  schemas: {
    Input: {
      type: "object", required: ["case_id", "payment"],
      properties: {
        case_id: { type: "string" },
        payment: { type: "object", required: ["descriptor"], properties: { descriptor: { type: "string" }, memo: { type: "string" }, merchant_site: { type: "string" }, amount: { type: "string" } }, description: "What the payment says about itself: card descriptor, memo, and the merchant's own site text." },
      },
    },
    Vote: {
      type: "object", additionalProperties: false, required: ["is_gambling"],
      properties: { is_gambling: { type: "boolean", description: "Is the payment described in `payment` a payment for gambling: staking money or a paid currency on a game of chance or skill for a chance to win money or prizes redeemable for money, including sweepstakes casinos and social casinos that pay out cash prizes?" } },
    },
    JuryDecision: {
      type: "object", required: ["case_id", "decision", "why", "mean", "spread", "votes"],
      properties: { case_id: { type: "string" }, decision: { type: "string", enum: ["gambling", "not_gambling"] }, why: { type: "string" }, mean: { type: "number" }, spread: { type: "number" }, stdev: { type: "number" }, votes: { type: "array" } },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "JuryDecision", path: "decision" },
  root: {
    node: "chain",
    steps: [
      {
        node: "parallel", label: "jury",
        branches: JURORS.map(({ label, provider, model, as }) => ({
          node: "judge", label, provider, ...(model ? { model } : {}), timeoutMs: 60000,
          state: { case_id: "{case_id}", payment: "{payment}" }, out: "Vote", as,
        })),
      },
      { node: "code", label: "aggregate", as: "verdict", code: aggregate },
      {
        node: "route", label: "agreement", valuePath: "verdict.action", as: "agreement_taken",
        branches: {
          auto_yes: { body: { node: "code", label: "auto_gambling", as: "decision", code: `(s) => ({ case_id: s.case_id, decision: "gambling", why: s.verdict.why, mean: s.verdict.mean, spread: s.verdict.spread, stdev: s.verdict.stdev, votes: s.verdict.votes })` } },
          auto_no: { body: { node: "code", label: "auto_not_gambling", as: "decision", code: `(s) => ({ case_id: s.case_id, decision: "not_gambling", why: s.verdict.why, mean: s.verdict.mean, spread: s.verdict.spread, stdev: s.verdict.stdev, votes: s.verdict.votes })` } },
          human_review: { body: { node: "escalate", label: "jury_split", when: { predicate: "field_equals", path: "verdict.action", value: "human_review" }, kind: "jury_review", stage: "jury", summary: "A person decides case {case_id}: {verdict.why}." } },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------- inputs

const docFiles = labels.documents.filter((d) => !d.file.startsWith("kyb-")).map((d) => d.file);
const packet = (id) => ({ company: labels.packets[id].company, jurisdiction: labels.packets[id].jurisdiction, documents: labels.packets[id].documents, as_of: AS_OF });
const inputs = {
  "doc-valid": { documents: ["coi-bramblewick-tidal-instruments.pdf"], as_of: AS_OF },
  "doc-valid-altered": { documents: ["coi-ashgrove-vireo-labs.pdf"], as_of: AS_OF },
  "doc-valid-borderline": { documents: ["coi-marrowfield-bakeworks.pdf"], as_of: AS_OF },
  "batch-20": { documents: docFiles, as_of: AS_OF },
  // The four KYB packet pages, which the thresholds above were not set on: a small held-out check of the batch workflow.
  "batch-20-holdout": { documents: labels.documents.filter((d) => d.file.startsWith("kyb-")).map((d) => d.file), as_of: AS_OF },
  "kyb": packet("brisklow"),
  "kyb-mismatch": packet("brisklow-mismatch"),
  "merchant-mcc": { merchant_name: "Kettlewick Roasters", url: "https://kettlewick-roasters.example/" },
  "merchant-mcc-restricted": { merchant_name: "Fernhollow Botanicals", url: "https://fernhollow-botanicals.example/" },
  "merchant-mcc-prohibited": { merchant_name: "Luxeparade Outlet", url: "https://luxeparade-outlet.example/" },
  // A real public merchant for a live run: the invented merchants exist only on the faux network.
  "merchant-mcc-live": { merchant_name: "Counter Culture Coffee", url: "https://www.counterculturecoffee.com/" },
  "jury": { case_id: "jury-clear", payment: { descriptor: "TILEWORKS SUPPLY CO 8885550142 OH", memo: "Invoice 4471: 40 pallets glazed ceramic floor tile", amount: "USD 18,420.00", merchant_site: "Tileworks Supply sells porcelain and ceramic tile to contractors across the Midwest." } },
  "jury-split": { case_id: "jury-split", payment: { descriptor: "GOLDRUSH SOCIAL* COINS 8885550199 NV", memo: "Gold Coin package 40,000 GC + 40 bonus Sweeps Coins", amount: "USD 39.99", merchant_site: "Goldrush Social is a free-to-play social casino. Buy Gold Coins to play for fun; Sweeps Coins come free with every package and can be redeemed for cash prizes where permitted. No purchase necessary." } },
  // Two more contested payments, added after jury-split's jurors agreed live: each was run once and is reported as it came out.
  "jury-event-contract": { case_id: "jury-event-contract", payment: { descriptor: "FORECASTLY EXCHANGE 8885550163 NY", memo: "Event contracts: 120 YES on 'Fed cuts rates in December' at $0.41", amount: "USD 49.20", merchant_site: "Forecastly is a regulated exchange for event contracts. Trade on the outcome of economic, weather and political events; a contract pays $1 if the event happens." } },
  "jury-fantasy": { case_id: "jury-fantasy", payment: { descriptor: "DRAFTGRID CONTESTS 8885550177 MA", memo: "Entry fee: Sunday NFL Showdown, 12-player contest, $500 prize pool", amount: "USD 50.00", merchant_site: "DraftGrid runs daily fantasy sports contests: pick a lineup under a salary cap and win cash prizes based on your players' real stats. Skill-based where permitted." } },
};
if (inputs["batch-20"].documents.length !== 20) throw new Error(`batch-20 needs 20 documents, labels.json has ${inputs["batch-20"].documents.length}`);

/** Which workflow each input runs. */
export const USE_CASES = {
  "doc-valid": { workflow: "doc-valid", inputs: ["doc-valid", "doc-valid-altered", "doc-valid-borderline"] },
  "batch-20": { workflow: "batch-20", inputs: ["batch-20", "batch-20-holdout"] },
  "kyb": { workflow: "kyb", inputs: ["kyb", "kyb-mismatch"] },
  "merchant-mcc": { workflow: "merchant-mcc", inputs: ["merchant-mcc", "merchant-mcc-restricted", "merchant-mcc-prohibited", "merchant-mcc-live"] },
  "jury": { workflow: "jury", inputs: ["jury", "jury-split", "jury-event-contract", "jury-fantasy"] },
};
export const WORKFLOWS = { "doc-valid": docValid, "batch-20": batch20, kyb, "merchant-mcc": merchantMcc, jury };
// Each workflow's input schema carries its use case's default input as an example (the console fills its composer from
// it). merchant-mcc's is an invented merchant on the faux network; a live run takes a real public URL instead
// (inputs/merchant-mcc-live.json).
for (const { workflow, inputs: names } of Object.values(USE_CASES)) WORKFLOWS[workflow].schemas.Input.examples = [inputs[names[0]]];
export const INPUTS = inputs;

if (import.meta.main) {
  mkdirSync(`${here}workflows`, { recursive: true });
  mkdirSync(`${here}inputs`, { recursive: true });
  for (const [name, wf] of Object.entries(WORKFLOWS)) writeFileSync(`${here}workflows/${name}.json`, `${JSON.stringify(wf, null, 2)}\n`);
  for (const [name, input] of Object.entries(inputs)) writeFileSync(`${here}inputs/${name}.json`, `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(`${here}use-cases.json`, `${JSON.stringify(USE_CASES, null, 2)}\n`);
  console.log(`wrote ${Object.keys(WORKFLOWS).length} workflows and ${Object.keys(inputs).length} inputs`);
}
