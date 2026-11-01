// The decision-workflow demo's workflows, as the console's fixtures draw them: the sprint's use cases (batch-20, kyb,
// jury, doc-valid, merchant-mcc) written by hand in the DSL's v2 shape. Every company is invented.

const yes = (description: string) => ({ type: "boolean", description });
const PAGES = { type: "object", required: ["name", "pageCount", "pages", "text"], properties: { name: { type: "string" }, pageCount: { type: "integer" }, pages: { type: "array" }, text: { type: "string" } } };
const PAGE = { type: "object", required: ["status", "text"], properties: { status: { type: "integer" }, url: { type: "string" }, title: { type: "string" }, text: { type: "string" } } };
const ANY = { type: "object" };

export const DOC_CHECKS = {
  type: "object",
  additionalProperties: false,
  required: ["altered", "seal", "signature", "legible"],
  properties: {
    altered: yes("Does the page show signs of digital alteration: mismatched fonts, misaligned lines, pasted regions or an edited date?"),
    seal: yes("Is a state seal or a filing stamp visible on the page?"),
    signature: yes("Is the certificate signed by a state official?"),
    legible: yes("Is the entity's full legal name legible on the page?"),
  },
};

export const batchWorkflow = {
  v: 2,
  name: "coi-batch-review",
  schemas: {
    Input: { type: "object", required: ["documents"], properties: { documents: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 } } },
    DocChecks: DOC_CHECKS,
    Pages: PAGES,
    Report: ANY,
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Report", path: "report" },
  root: {
    node: "chain",
    steps: [
      {
        node: "map", label: "each-document", itemsPath: "documents", as: "rows", maxConcurrency: 4, onItemFailure: "collect", failedAs: "failed",
        body: {
          node: "chain",
          steps: [
            { node: "call", label: "render-pages", via: "tool", tool: "pdf_pages", args: { path: "{item}", maxPages: 2 }, out: "Pages", as: "pages", deadline_s: 60 },
            {
              node: "judge", label: "inspect-certificate", provider: "jev",
              state: { document: "{item}", page: "<page1>", text: "{pages.text}" },
              images: { "<page1>": "{pages.pages.0.image}" },
              out: "DocChecks", as: "checks",
            },
            { node: "code", label: "grade", code: "(s) => ({ document: s.item, verdict: s.checks.altered || !s.checks.seal || !s.checks.legible ? 'doubtful' : 'valid', checks: s.checks })", as: "row" },
          ],
        },
      },
      { node: "code", label: "batch-report", code: "(s) => ({ valid: s.rows.filter((r) => r && r.verdict === 'valid').length, doubtful: s.rows.filter((r) => r && r.verdict === 'doubtful').map((r) => r.document), failed: s.failed })", as: "report" },
    ],
  },
};

export const kybWorkflow = {
  v: 2,
  name: "kyb-onboarding",
  schemas: {
    Pages: PAGES,
    Result: ANY,
    Input: { type: "object", required: ["company", "state", "registration_number", "documents"], properties: { company: { type: "string" }, state: { type: "string" }, registration_number: { type: "string" }, documents: { type: "array", items: { type: "string" } } } },
    Registry: {
      type: "object", additionalProperties: false, required: ["registered", "active", "name_matches"],
      properties: {
        registered: yes("Is a company with this exact registration number on file with the named state's business registry?"),
        active: yes("Is that registration currently active (in good standing, not dissolved, forfeited or revoked)?"),
        name_matches: yes("Does the registry's legal name match the applicant's name, ignoring punctuation and suffix style?"),
      },
    },
    CertLook: {
      type: "object", additionalProperties: false, required: ["altered", "seal", "legible"],
      properties: { altered: DOC_CHECKS.properties.altered, seal: DOC_CHECKS.properties.seal, legible: DOC_CHECKS.properties.legible },
    },
    CrossCheck: {
      type: "object", additionalProperties: false, required: ["same_entity", "same_state", "dates_consistent"],
      properties: {
        same_entity: yes("Do the registry record and the certificate name the same legal entity?"),
        same_state: yes("Do they name the same state of incorporation?"),
        dates_consistent: yes("Is the certificate's filing date consistent with the registry's formation date (within 3 days)?"),
      },
    },
  },
  input: { schemaId: "Input" },
  root: {
    node: "chain",
    steps: [
      { node: "call", label: "render-certificate", via: "tool", tool: "pdf_pages", args: { path: "{documents.0}", maxPages: 1 }, out: "Pages", as: "cert", deadline_s: 60 },
      {
        node: "parallel", label: "checks",
        branches: [
          { node: "judge", label: "registry-lookup", provider: "parallel", model: "standard", state: { company: "{company}", state: "{state}", registration_number: "{registration_number}" }, out: "Registry", as: "registry" },
          { node: "judge", label: "certificate-look", provider: "jev", state: { page: "<cert>", text: "{cert.text}" }, images: { "<cert>": "{cert.pages.0.image}" }, out: "CertLook", as: "look" },
        ],
      },
      { node: "judge", label: "cross-check", provider: "jev", state: { applicant: { company: "{company}", state: "{state}" }, registry: "{registry$answers}", certificate_text: "{cert.text}" }, out: "CrossCheck", as: "cross" },
      {
        node: "route", label: "decide", provider: "jev",
        state: { registry: "{registry}", look: "{look}", cross: "{cross}" },
        instructions: "Decide the onboarding outcome for this business from the registry check, the certificate's look and the cross-check.",
        branches: {
          approve: { criteria: "Registered, active, the certificate looks genuine, and every cross-check agrees.", body: { node: "code", label: "record-approval", code: "(s) => ({ outcome: 'approved' })", as: "outcome" } },
          review: { criteria: "Mostly consistent, but one check is doubtful or the evidence disagrees on a detail.", body: { node: "code", label: "open-review-case", code: "(s) => ({ outcome: 'review', reasons: s.cross })", as: "outcome" } },
          reject: { criteria: "Not registered, dissolved, or the certificate is altered.", body: { node: "code", label: "record-rejection", code: "(s) => ({ outcome: 'rejected' })", as: "outcome" } },
        },
        unsure: { branch: "review", gte: 0.75 },
      },
    ],
  },
  output: { schemaId: "Result", path: "outcome" },
};

const PROHIBITED = { type: "object", additionalProperties: false, required: ["prohibited"], properties: { prohibited: yes("Does this merchant sell goods the card networks prohibit: weapons, controlled substances, counterfeit goods, or unlicensed nicotine products?") } };
const juror = (label: string, provider: string, model?: string) => ({ node: "judge", label, provider, ...(model ? { model } : {}), state: { merchant: "{merchant}", url: "{url}", page_text: "{page.text}" }, out: "Prohibited", as: label.replace(/-/g, "_") });

export const juryWorkflow = {
  v: 2,
  name: "prohibited-goods-jury",
  schemas: {
    Page: PAGE,
    Result: ANY,
    Input: { type: "object", required: ["merchant", "url"], properties: { merchant: { type: "string" }, url: { type: "string" } } },
    Prohibited: PROHIBITED,
  },
  input: { schemaId: "Input" },
  root: {
    node: "chain",
    steps: [
      { node: "call", label: "fetch-storefront", via: "tool", tool: "fetch_page", args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 },
      {
        node: "parallel", label: "jury",
        branches: [
          juror("jev", "jev"),
          juror("pplx-decider", "openrouter", "perplexity/pplx-decider-v1.2"),
          juror("liquid-d1", "openrouter", "liquid/d1"),
          juror("clef", "openrouter", "cloudflare/clef"),
        ],
      },
      { node: "code", label: "aggregate", code: "(s) => { const p = [s.jev$answers, s.pplx_decider$answers, s.liquid_d1$answers, s.clef$answers].map((a) => a.answers.prohibited.noul); const mean = p.reduce((x, y) => x + y, 0) / p.length; const spread = Math.max(...p) - Math.min(...p); return { mean, spread, outcome: spread > 0.3 ? 'disagree' : 'agree' }; }", as: "agreement" },
      {
        node: "route", label: "agreement", valuePath: "agreement.outcome",
        branches: {
          agree: { body: { node: "code", label: "auto-decide", code: "(s) => ({ decision: s.agreement.mean >= 0.5 ? 'decline' : 'approve' })", as: "decision" } },
          disagree: { body: { node: "code", label: "human-review", code: "(s) => ({ decision: 'review', spread: s.agreement.spread })", as: "decision" } },
        },
      },
    ],
  },
  output: { schemaId: "Result", path: "decision" },
};

export const docValidWorkflow = {
  v: 2,
  name: "coi-validity",
  schemas: {
    Pages: PAGES,
    Result: ANY,
    Input: { type: "object", required: ["documents"], properties: { documents: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 } } },
    DocChecks: DOC_CHECKS,
  },
  input: { schemaId: "Input" },
  root: {
    node: "chain",
    steps: [
      { node: "call", label: "render-pages", via: "tool", tool: "pdf_pages", args: { path: "{documents.0}", maxPages: 2 }, out: "Pages", as: "pages", deadline_s: 60 },
      { node: "judge", label: "inspect-certificate", provider: "jev", state: { page: "<page1>", text: "{pages.text}" }, images: { "<page1>": "{pages.pages.0.image}" }, out: "DocChecks", as: "checks" },
      {
        node: "route", label: "validity", provider: "jev",
        state: { checks: "{checks}", answers: "{checks$answers}" },
        instructions: "Is this certificate valid enough to accept without a person looking at it?",
        branches: {
          valid: { criteria: "Not altered, sealed, signed and legible, each with high confidence.", body: { node: "code", label: "accept", code: "(s) => ({ status: 'accepted' })", as: "result" } },
          doubtful: {
            criteria: "Any sign of alteration, or a missing seal, signature or legible name.",
            body: { node: "chain", steps: [
              { node: "code", label: "flag", code: "(s) => ({ flag: true })", as: "review" },
              { node: "escalate", label: "send-to-review", when: { predicate: "field_equals", path: "review.flag", value: true }, kind: "document_review", stage: "verification", summary: "A person checks the certificate." },
            ] },
          },
        },
        unsure: { branch: "doubtful", gte: 0.8 },
      },
    ],
  },
  output: { schemaId: "Result", path: "result" },
};

export const merchantWorkflow = {
  v: 2,
  name: "merchant-mcc",
  schemas: {
    Page: PAGE,
    Result: ANY,
    Input: { type: "object", required: ["merchant", "url"], properties: { merchant: { type: "string" }, url: { type: "string" } } },
    Prohibited: PROHIBITED,
    Codes: { type: "array", items: { type: "object", properties: { mcc: { type: "string" }, name: { type: "string" } } } },
  },
  input: { schemaId: "Input" },
  root: {
    node: "chain",
    steps: [
      { node: "call", label: "fetch-storefront", via: "tool", tool: "fetch_page", args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 },
      { node: "code", label: "candidate-codes", code: "(s) => ({ codes: [{ mcc: '5993', name: 'Cigar stores and stands' }, { mcc: '5999', name: 'Miscellaneous retail' }, { mcc: '5912', name: 'Drug stores and pharmacies' }, { mcc: '5441', name: 'Candy, nut and confectionery stores' }] })", as: "mcc" },
      { node: "pick", label: "pick-mcc", provider: "jev", itemsPath: "mcc.codes", describe: "{item.mcc} {item.name}", instructions: "Which merchant category code fits what this storefront sells?", state: { merchant: "{merchant}", page_text: "{page.text}" }, allowNone: true, as: "code" },
      { node: "judge", label: "prohibited-goods", provider: "parallel", model: "fast", state: { merchant: "{merchant}", url: "{url}" }, out: "Prohibited", as: "risk" },
      {
        node: "route", label: "by-risk", provider: "jev",
        state: { code: "{code}", risk: "{risk$answers}" },
        instructions: "How risky is onboarding this merchant?",
        branches: {
          low: { criteria: "No prohibited goods, a standard code.", body: { node: "code", label: "approve", code: "(s) => ({ decision: 'approve' })", as: "decision" } },
          high: { criteria: "Prohibited goods likely, or a high-risk code.", body: { node: "code", label: "enhanced-review", code: "(s) => ({ decision: 'review' })", as: "decision" } },
        },
        unsure: { branch: "high", gte: 0.7 },
      },
    ],
  },
  output: { schemaId: "Result", path: "decision" },
};
