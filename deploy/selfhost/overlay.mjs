// The walk's change to a template (walk.sh): the image's own command with the faux model of deploy/walk/faux-steps.mjs
// (no key, no network), deploy/walk mounted read-only at /walk, and the usage counts off. Everything else, the
// platform's variables included, is the template as it is; WALK_IMAGE=<image> walks that image in place of the template's.
//   node overlay.mjs <template compose file> <deploy/walk's absolute path>   prints the compose file the walk deploys
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

const [file, walk] = process.argv.slice(2);
const doc = parseDocument(readFileSync(file, "utf8"));
const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(readFileSync(new URL("../../packages/serve/docker/Dockerfile", import.meta.url), "utf8"))[1]);
const service = ["services", "agentrun"];
doc.setIn([...service, "command"], [...cmd, "--faux", "/walk/faux-steps.mjs"]);
doc.addIn([...service, "volumes"], `${walk}:/walk:ro`);
if (process.env.WALK_IMAGE) doc.setIn([...service, "image"], process.env.WALK_IMAGE);
const env = doc.getIn([...service, "environment"]);
if (env?.items && !env.items[0]?.key) doc.addIn([...service, "environment"], "AGENTRUN_TELEMETRY=0");
else doc.setIn([...service, "environment", "AGENTRUN_TELEMETRY"], "0");
process.stdout.write(doc.toString({ lineWidth: 0 }));
