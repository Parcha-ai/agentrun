// Every built-in provider's descriptor, in the order Settings shows them. Importing this loads descriptors (data) alone:
// each provider module loads only when its descriptor's load() is called.
import { BROWSERBASE } from "./browserbase.js";
import { DAYTONA } from "./daytona.js";
import { DOCKER } from "./docker.js";
import { E2B } from "./e2b.js";
import { KERNEL } from "./kernel.js";
import { MODAL } from "./modal.js";
import { ORGO } from "./orgo.js";
import { PHONE_HARNESS } from "./phone-harness.js";

export const DESCRIPTORS = [DOCKER, DAYTONA, MODAL, E2B, ORGO, PHONE_HARNESS, BROWSERBASE, KERNEL] as const;

export { BROWSERBASE, DAYTONA, DOCKER, E2B, KERNEL, MODAL, ORGO, PHONE_HARNESS };
export { DAYTONA_DEFAULT_SNAPSHOT } from "./daytona.js";
export { E2B_BASE_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b.js";
export { MODAL_DEFAULT_IMAGE } from "./modal.js";
export { ORGO_BASE_IMAGE } from "./orgo.js";
export { PHONE_GROUPS, PHONE_IMAGE } from "./phone-harness.js";
export { BROWSER_IMAGE, LINUX_DESKTOP, SANDBOX } from "./shared.js";
