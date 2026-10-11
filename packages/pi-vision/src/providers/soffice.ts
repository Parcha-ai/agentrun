// A faithful render of an office document: LibreOffice in the environment converts it to PDF with a private profile,
// and the PDF is read as one.
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

export function sofficeProvider(): Provider {
  return notBuilt("sofficeProvider");
}
