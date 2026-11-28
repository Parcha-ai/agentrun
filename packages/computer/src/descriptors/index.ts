// Every built-in provider's descriptor, in the order Settings shows them. Importing this loads descriptors (data) alone:
// each provider module loads only when its descriptor's load() is called.
import { AGENT37 } from "./agent37.js";
import { BOXD } from "./boxd.js";
import { BROWSERBASE } from "./browserbase.js";
import { CLOUDFLARE } from "./cloudflare.js";
import { DAYTONA } from "./daytona.js";
import { DOCKER } from "./docker.js";
import { E2B } from "./e2b.js";
import { FLY } from "./fly.js";
import { GROUNDBOX } from "./groundbox.js";
import { INSTABOX } from "./instabox.js";
import { KERNEL } from "./kernel.js";
import { LOCAL } from "./local-chrome.js";
import { MODAL } from "./modal.js";
import { MORPH } from "./morph.js";
import { ORGO } from "./orgo.js";
import { PHONE_HARNESS } from "./phone-harness.js";
import { RENDER } from "./render.js";
import { SMOLCLOUD } from "./smolcloud.js";
import { SPRITES } from "./sprites.js";
import { TENSORLAKE } from "./tensorlake.js";
import { VERCEL } from "./vercel.js";

export const DESCRIPTORS = [DOCKER, DAYTONA, MODAL, E2B, AGENT37, MORPH, CLOUDFLARE, FLY, RENDER, ORGO, PHONE_HARNESS, BROWSERBASE, KERNEL, LOCAL, BOXD, SMOLCLOUD, GROUNDBOX, VERCEL, SPRITES, INSTABOX, TENSORLAKE] as const;

export { AGENT37, BOXD, BROWSERBASE, CLOUDFLARE, DAYTONA, DOCKER, E2B, FLY, GROUNDBOX, INSTABOX, KERNEL, LOCAL, MODAL, MORPH, ORGO, PHONE_HARNESS, RENDER, SMOLCLOUD, SPRITES, TENSORLAKE, VERCEL };
export { AGENT37_BASE_TEMPLATE } from "./agent37.js";
export { BOXD_DEFAULT_IMAGE } from "./boxd.js";
export { GROUNDBOX_OWN_IMAGE } from "./groundbox.js";
export { INSTABOX_IMAGE } from "./instabox.js";
export { SPRITES_IMAGE } from "./sprites.js";
export { TENSORLAKE_IMAGE } from "./tensorlake.js";
export { DAYTONA_DEFAULT_SNAPSHOT, DAYTONA_GPU_SNAPSHOT, type DaytonaGpuSnapshot, daytonaGpu, daytonaGpuSnapshot } from "./daytona.js";
export { ORGO_BASE_IMAGE } from "./orgo.js";
export { PHONE_GROUPS, PHONE_IMAGE } from "./phone-harness.js";
export { BROWSER_IMAGE, LINUX_DESKTOP, SANDBOX } from "./shared.js";
