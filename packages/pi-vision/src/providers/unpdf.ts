// PDF text with nothing installed: pdf.js through `unpdf`, loaded on first use.
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

export function unpdfProvider(): Provider {
  return notBuilt("unpdfProvider");
}
