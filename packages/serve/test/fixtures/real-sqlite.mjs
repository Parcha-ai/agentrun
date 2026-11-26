// node:sqlite as dist code sees it: the resolve hook (sqlite-guard-hooks.mjs) lets this module through to the real one.
export { DatabaseSync } from "node:sqlite";
