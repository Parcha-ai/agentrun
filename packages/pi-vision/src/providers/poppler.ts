// PDF text and pages through poppler in the environment (`pdftotext -layout`, `pdftoppm`, `pdfinfo`), when it is
// installed there.
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

export function popplerProvider(): Provider {
  return notBuilt("popplerProvider");
}
