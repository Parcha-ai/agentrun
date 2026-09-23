import { workflowPolicyErrors } from "./admission.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { validateWorkflow, type Workflow } from "@parcha/agentrun-dsl";
import { createPiRunner, type PiRunnerOptions } from "./runner.js";

export const AUTHOR_CONTRACT = `You author AgentRun DSL v2 workflows as JSON data.
Deliver with the submit tool, never prose or a filename. Make the smallest workflow satisfying the request.
The document has v:2, name, schemas (JSON Schema catalog), optional input:{schemaId}, output:{schemaId,path?}, root.
Every referenced schema must exist. Each LLM node has node:agent|decide|extract, label, instructions, out (schema id), as (state key), optional requires/tools/sopSection.
A chain has node:chain, steps:[nodes]. A map has label, itemsPath, body, as, maxConcurrency. A loop has label, body, until, maxIters.
A judge has label,state,out,as. Judge schemas use flat boolean/enum/integer properties; each property's description states its question. A route has label,state,instructions,branches:{name:{criteria,body}}, optional unsure:{branch,gte} and as.
LLM instructions are literal text, never interpolated. The node receives workflow state as a JSON user message; refer to its keys in ordinary prose and declare required keys in requires. Use {stateKey} placeholders only in interpolated fields such as judge.state and call.args; whole placeholders preserve their value's type. Output.path selects a final state value validated by output.schemaId.
Only use tools named by the host. Never invent a tool, capability, evidence source or successful test.
Keep the full rubric in its original source text. Every LLM node's sopSection must include ALL supplied rubric section names. Merged judgments inherit their parents' union. Do not paraphrase policy into instructions. If rubric sections are supplied, use LLM nodes for judgment; Jev nodes do not carry sopSection and require a separately reviewed question contract.
Keep independent acceptance checks host-owned; never change their implementation, fixtures or thresholds to pass. A valid candidate is not automatically activated.
Code, shell/effect calls and artifact delivery require explicit host authorization. Bound loops and parallelism; uncertainty should escalate or select an explicit fallback.
Example: {"v":2,"name":"summarize","schemas":{"Result":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}},"output":{"schemaId":"Result","path":"result"},"root":{"node":"extract","label":"summarize","instructions":"Summarize the text field from the JSON input faithfully.","out":"Result","as":"result","requires":["text"]}}`;

export interface AuthorWorkflowOptions {
  request: string;

  outputDir: string;
  pi: PiRunnerOptions;
  inputKeys?: string[];
  rubricSections?: Record<string, string>;

  allowExecutableCandidates?: boolean;
  maxCandidates?: number;

  acceptance?: (candidate: Workflow) => Promise<string[]> | string[];
}
export interface AuthoredWorkflow {
  workflow: Workflow;
  path: string;
  directory: string;
  candidates: number;

  checks: "structural" | "structural-and-host";
}

export async function authorWorkflow(options: AuthorWorkflowOptions): Promise<AuthoredWorkflow> {
  if (!options.request.trim()) throw new Error("Workflow request is required");
  const maxCandidates = options.maxCandidates ?? 4;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error("maxCandidates must be a positive integer");
  const directory = resolve(options.outputDir, `candidate-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "request.json"), JSON.stringify({ request: options.request, inputKeys: options.inputKeys ?? [], rubricSections: options.rubricSections ?? {}, allowExecutableCandidates: options.allowExecutableCandidates ?? false, maxCandidates }, null, 2), { flag: "wx" });
  let candidates = 0;
  let acceptedPath: string | undefined;
  const runner = createPiRunner({ ...options.pi, tools: [], maxSubmissions: maxCandidates });
  try {
    const workflow = await runner({
      kind: "agent", label: "author-workflow", tools: [],
      system: [AUTHOR_CONTRACT, `Executable candidates authorized: ${options.allowExecutableCandidates ?? false}.`, `All supplied rubric sections (authoritative): ${JSON.stringify(options.rubricSections ?? {})}`],
      user: `${options.request}\nAvailable input keys: ${JSON.stringify(options.inputKeys ?? [])}`,
      schema: { type: "object", additionalProperties: true },
      async review(value) {
        candidates++;
        if (candidates > maxCandidates) throw new Error("Candidate limit exceeded");
        const candidatePath = join(directory, `${String(candidates).padStart(3, "0")}.json`);
        await writeFile(candidatePath, JSON.stringify(value, null, 2), { flag: "wx" });
        const errors = workflowPolicyErrors(value, options);
        if (!errors.length) {
          try {
            const verdict = validateWorkflow(value as Workflow, { inputKeys: options.inputKeys });
            if (!verdict.ok) errors.push(...verdict.errors);
          } catch (error) { errors.push(`Invalid workflow: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (!errors.length && options.acceptance) errors.push(...await options.acceptance(structuredClone(value) as Workflow));
        await writeFile(join(directory, `${String(candidates).padStart(3, "0")}.review.json`), JSON.stringify({ accepted: !errors.length, checks: options.acceptance ? "structural-and-host" : "structural", errors }, null, 2), { flag: "wx" });
        if (errors.length) return { accepted: false, message: errors.join("\n") };
        acceptedPath = candidatePath;
        return { accepted: true };
      },
    }) as Workflow;
    if (!acceptedPath) throw new Error("Author returned without a retained accepted candidate");
    await writeFile(join(directory, "result.json"), JSON.stringify({ status: "candidate", path: acceptedPath, candidates }, null, 2), { flag: "wx" });
    return { workflow, path: acceptedPath, directory, candidates, checks: options.acceptance ? "structural-and-host" : "structural" };
  } catch (error) {
    await writeFile(join(directory, "result.json"), JSON.stringify({ status: "failed", candidates, message: error instanceof Error ? error.message : String(error) }, null, 2), { flag: "wx" });
    throw error;
  }
}
