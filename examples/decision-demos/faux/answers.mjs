// The faux decision models' answers: each question id the demo workflows ask, answered from documents/labels.json and
// fixtures.mjs, with a small fixed jitter so no two documents read exactly alike. Jev and the OpenRouter models share it.
import { choiceAnswer, choiceAtConfidence, clamp, documentsIn, jitter, round } from "./common.mjs";
import { jury, merchants, overrides } from "./fixtures.mjs";

const ALTERED = ["altered_date", "pasted_field", "inconsistent_fonts"];
const has = (doc, kind) => Boolean(doc?.defects?.some((d) => d.kind === kind));
const altered = (doc) => ALTERED.some((k) => has(doc, k));
const unsigned = (doc) => has(doc, "missing_seal") || has(doc, "missing_signature");
const TYPE_OF_PREFIX = { coi: "certificate_of_incorporation", ein: "ein_letter", bank: "bank_letter" };

/** The yes-probability a careful reader of `doc`'s page gives question `id`, before jitter. */
function documentNoul(id, doc) {
  const kind = id.replace(/^(coi|ein|bank)_/, "");
  switch (kind) {
    case "is_certificate": return doc.type === "certificate_of_incorporation" ? 0.97 : 0.03;
    case "looks_altered": case "altered": return altered(doc) ? 0.9 : has(doc, "name_mismatch") ? 0.46 : 0.07;
    case "seal_present": return has(doc, "missing_seal") ? 0.06 : doc.type === "certificate_of_incorporation" ? 0.94 : 0.2;
    case "signature_present": case "signed": return has(doc, "missing_signature") ? 0.05 : 0.93;
    case "authenticated": case "executed": return unsigned(doc) ? 0.08 : 0.92;
    case "issuer_marks": case "sealed": return has(doc, "missing_seal") ? 0.08 : 0.94;
    case "fonts_match": return has(doc, "inconsistent_fonts") ? 0.1 : 0.93;
    case "name_consistent": return has(doc, "name_mismatch") ? 0.06 : 0.95;
    case "date_not_future": return has(doc, "future_date") ? 0.04 : 0.96;
    default: return undefined;
  }
}

/** The document a question is about: for kyb's prefixed ids (coi_altered), the packet's document of that kind. */
function subjectOf(id, docs) {
  const prefix = /^(coi|ein|bank)_/.exec(id)?.[1];
  if (prefix) return docs.find((d) => d.type === TYPE_OF_PREFIX[prefix]) ?? docs[0];
  return docs[0];
}

const merchantIn = (state) => {
  const text = JSON.stringify(state ?? {});
  return Object.values(merchants).find((m) => text.includes(m.name));
};

/** Answers for every question in a System One request, as model `model` would give them (`jev` for Jev). */
export function answer({ state, questions, model }) {
  const docs = documentsIn(state);
  const merchant = merchantIn(state);
  const caseId = typeof state === "object" && state ? state.case_id : undefined;
  const seed = JSON.stringify(state ?? {}).slice(0, 2000);
  const answers = {};
  for (const [id, question] of Object.entries(questions ?? {})) {
    const j = jitter(model, id, seed) * 0.03;
    if (question.type === "noul") {
      let p;
      const doc = subjectOf(id, docs);
      const override = doc && overrides[doc.file]?.[id];
      if (typeof override === "number") p = override;
      else if (id === "is_gambling" && caseId && jury[caseId]) p = jury[caseId][model] ?? jury[caseId].jev;
      else if (id === "advertises_prohibited" && merchant) p = merchant.page.prohibited;
      else if (id === "advertises_restricted" && merchant) p = merchant.page.restricted;
      else if (id === "same_entity" && docs.length) p = docs.every((d) => d.company === state.company) ? 0.95 : 0.09;
      else if (id === "same_state" && docs.length) p = 0.94;
      else if (id === "dates_consistent" && docs.length) {
        const date = (type) => docs.find((d) => d.type === type)?.date ?? "";
        const [coi, ein, bank] = [date("certificate_of_incorporation"), date("ein_letter"), date("bank_letter")];
        p = coi <= ein && ein <= bank && bank <= (state.as_of ?? "9999") ? 0.93 : 0.12;
      } else if (doc) p = documentNoul(id, doc);
      answers[id] = { type: "noul", noul: round(clamp((p ?? 0.5) + (typeof override === "number" ? 0 : j))) };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      const doc = docs[0];
      if (id === "branch" && doc) {
        // The second look: the override's choice and confidence, else what the labels say, sure of it.
        const o = overrides[doc.file]?.branch ?? { choice: doc.valid ? "valid" : "doubtful", confidence: 0.88 + j };
        answers[id] = choiceAtConfidence(options, options.includes(o.choice) ? o.choice : options[0], o.confidence);
      } else if (id === "doc_type" && doc) {
        answers[id] = choiceAnswer(options, options.includes(doc.type) ? doc.type : "other", 0.95 + j);
      } else if (id === "pick" && merchant) {
        const candidates = state?.candidates ?? {};
        const chosen = Object.keys(candidates).find((key) => String(candidates[key]).startsWith(`${merchant.mcc}:`)) ?? options.at(-1);
        answers[id] = choiceAnswer(options, chosen, 0.82 + j);
      } else {
        answers[id] = choiceAnswer(options, options[0], 0.6 + j);
      }
    } else if (question.type === "score") {
      const levels = question.criteria.length;
      answers[id] = { type: "score", score: 0, confidence: 0.7, legend: Object.fromEntries(question.criteria.map((v, i) => [i, v])), probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, round(i === 0 ? 0.8 : 0.2 / (levels - 1))])) };
    } else {
      answers[id] = { type: "refusal" };
    }
  }
  return answers;
}
