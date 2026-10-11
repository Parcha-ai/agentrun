// Type tests for the leak check, checked by `npm run typecheck`: a host's composition test hands it a result as pi-ai
// builds one and the limits it resolved, with no conversion.

import type { ImageContent as PiImageContent, TextContent as PiTextContent } from "@earendil-works/pi-ai";
import { resolveLimits } from "../../src/index.js";
import { LeakScan, SENTINELS, SENTINEL_EYES_KEY, limitViolations, signedLink } from "../../src/testing/index.js";

const violations = (text: PiTextContent, image: PiImageContent): string[] => limitViolations({ content: [text, image] }, resolveLimits(undefined));
// @ts-expect-error a result with no content is not one.
limitViolations({}, resolveLimits(undefined));

// A scan looks for the package's sentinels, or for a set of its own.
const scan = new LeakScan();
const own = new LeakScan({ custom: SENTINEL_EYES_KEY });
const findings: readonly { sentinel: string; form: string; source: string; where: string }[] = scan.findings;
// @ts-expect-error the sentinels are read only.
SENTINELS.eyesKey = "";

void [violations, own, findings, signedLink("a.pdf")];
