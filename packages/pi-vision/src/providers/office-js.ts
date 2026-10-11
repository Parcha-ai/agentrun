// Office documents with nothing installed, read by the package's own reader on fflate and @xmldom/xmldom: the text of
// docx and odt, the slides of pptx and odp in order with their notes, and the cells of xlsx and ods with value, formula
// and stored value, a formula with no stored value said, not dropped. RTF reads as its source text.
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

export function officeJsProvider(): Provider {
  return notBuilt("officeJsProvider");
}
