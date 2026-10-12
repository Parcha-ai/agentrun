// The package's own providers, in the order to try them: a program in the environment before the zero-install reader
// that does the same job. A host puts its own first; each provider's detection decides whether it runs where the call
// runs. Making the list loads none of their dependencies.
import type { Provider } from "../core/provider.js";
import { ffmpegProvider } from "./ffmpeg.js";
import { officeJsProvider } from "./office-js.js";
import { pdfiumProvider } from "./pdfium.js";
import { popplerProvider } from "./poppler.js";
import { sofficeProvider } from "./soffice.js";
import { unpdfProvider } from "./unpdf.js";

export function packageProviders(): Provider[] {
  return [popplerProvider(), pdfiumProvider(), unpdfProvider(), officeJsProvider(), sofficeProvider(), ffmpegProvider()];
}
