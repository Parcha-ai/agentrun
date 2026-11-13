// The repository a run a person starts reaches (the start body's `repo`): what an agent is bound to, and which one a start
// may name. A run a GitHub trigger starts has its repository from the signed event; a run started by hand has none unless
// the start gives it, since the GitHub App's token is made for one repository and never for all it covers.
//
// An agent is bound to the repositories its GitHub triggers take events from: each rule's `where` condition on
// /repository/full_name, its `in` list. A start's `repo` must be one of them, so a start never reaches a repository the
// agent's own triggers do not; naming one the agent is not bound to is refused in words. A start that names none takes the
// agent's repository when it is bound to exactly one. A trigger rule with no such condition takes every repository the App
// is installed on: the agent is then bound to all of them (`open`), a start may name any, and none is taken by default.
import { isObject } from "./validate.js";

/** `owner/name`, as github.ts githubTargetOf reads a repository. */
export const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;

/** What an agent's GitHub triggers bind it to: the repositories they name, and whether one takes events from any. */
export type RepoBinding = { readonly repos: readonly string[]; readonly open: boolean };

const FULL_NAME = "/repository/full_name";

/** `agentId`'s binding, from the triggers (their source and target as stored): none (no repos, not open) for an agent no
 *  GitHub trigger starts. */
export function bindingOf(triggers: readonly { readonly source: unknown; readonly target: unknown }[], agentId: string): RepoBinding {
  const repos: string[] = [];
  let open = false;
  for (const { source, target } of triggers) {
    if (!isObject(target) || target.kind !== "start_run" || target.agent_id !== agentId) continue;
    if (!isObject(source) || source.kind !== "github") continue;
    const rules = Array.isArray(source.accept) ? source.accept : [];
    // A github trigger with no accept takes every event the App sends, from any repository.
    if (!rules.length) open = true;
    for (const rule of rules) {
      // A rule's conditions all hold: each `in` list on the repository narrows the rule, so they are intersected; rules
      // are alternatives, so what they name is joined.
      let named: string[] | undefined;
      for (const c of isObject(rule) && Array.isArray(rule.where) ? rule.where : []) {
        if (!isObject(c) || c.pointer !== FULL_NAME || !Array.isArray(c.in)) continue;
        const list = c.in.filter((v): v is string => typeof v === "string" && REPO_NAME.test(v));
        named = named === undefined ? list : named.filter((r) => list.some((l) => l.toLowerCase() === r.toLowerCase()));
      }
      if (named === undefined) open = true;
      for (const repo of named ?? []) if (!repos.some((r) => r.toLowerCase() === repo.toLowerCase())) repos.push(repo);
    }
  }
  return { repos, open };
}

/** The repository a manual start runs against: `named` (the body's `repo`) when it is one the agent is bound to, else the
 *  agent's one repository when `named` is absent and the first message names none (`words`: it names its own). Undefined
 *  when the run is to have none. `refused`: why a named one is not allowed, in words for the 422. */
export function repoOf(binding: RepoBinding, named: string | undefined, words: boolean): { repo?: string; refused?: string } {
  if (named === undefined) return !binding.open && binding.repos.length === 1 && !words ? { repo: binding.repos[0]! } : {};
  const bound = binding.repos.find((r) => r.toLowerCase() === named.toLowerCase());
  if (bound) return { repo: bound };
  if (binding.open) return { repo: named };
  return {
    refused: binding.repos.length
      ? `This agent is bound to ${binding.repos.join(", ")}, not ${named}: start the run with one of those, or leave repo out.`
      : `This agent is bound to no GitHub repository, so a run of it cannot name ${named}: bind it with a GitHub trigger whose accept names the repository, or write the repository's URL in the run's first message.`,
  };
}
