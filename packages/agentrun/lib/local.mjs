// The CLI's hand-written commands, which run as they are given beside the generated table's: cli.mjs runs them, and the
// table's generator (scripts/generate-clients.mjs) reads them so no generated command takes one of their names and the
// skill lists them. A command that calls the API names its routes (`route`), which the skill prints.
import { DEPLOY, DEPLOY_DELETE, DEPLOY_ROLLBACK } from "./deploy.mjs";
import { DOCTOR } from "./doctor.mjs";
import { EXPORT } from "./export.mjs";
import { HARNESS_CHECK, HARNESS_INSTALL, HARNESS_SIGN_IN } from "./harness.mjs";
import { SECRETS } from "./login.mjs";
import { OPEN, SERVICE, STOP } from "./service.mjs";
import { SKILL_INSTALL } from "./skill.mjs";
import { TEMPLATE_EVAL, TEMPLATE_INSTALL, TEMPLATE_VALIDATE } from "./template.mjs";

export const LOCAL = [...SECRETS, SKILL_INSTALL, TEMPLATE_VALIDATE, TEMPLATE_EVAL, TEMPLATE_INSTALL, EXPORT, HARNESS_INSTALL, HARNESS_SIGN_IN, HARNESS_CHECK, ...SERVICE, STOP, OPEN, DOCTOR, DEPLOY, DEPLOY_ROLLBACK, DEPLOY_DELETE];
