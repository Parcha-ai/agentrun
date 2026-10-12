// Type tests, checked by `npm run typecheck`: the package's own kind wiring is importable from the package's entry and
// is what `readMedia` takes, so a host adds or replaces one reader and keeps the rest.

import { PACKAGE_KINDS, type KindReader, type ReadKinds } from "../../src/index.js";

const kinds: ReadKinds = PACKAGE_KINDS;
const sheets: KindReader = async () => ({ refusal: "sheets are read by the host's own tool" });
const extended: ReadKinds = { ...PACKAGE_KINDS, readers: { ...PACKAGE_KINDS.readers, sheet: sheets } };
// @ts-expect-error a reader that answers nothing a read can show is not a reader.
const broken: KindReader = async () => ({ nothing: true });

void [kinds, extended, broken];
