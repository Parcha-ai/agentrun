import { describe, expect, it } from "vitest";
import { httpHref } from "./safeUrl";

// A URL from server data (a fetched page's citation, an image a provider saw) is a link only when it is http or https, as the
// URL parser reads it: case, leading spaces and a tab inside the scheme are its to normalize, so none of them gets through.
describe("httpHref", () => {
  it("keeps http and https URLs", () => {
    expect(httpHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(httpHref("http://example.com/page")).toBe("http://example.com/page");
    expect(httpHref("HTTPS://Example.com/x")).toBe("https://example.com/x");
  });
  it("refuses every other scheme, however it is spelled, and anything that is no URL", () => {
    for (const u of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "\u0001javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "ftp://example.com/x", "/v2/runs/r/files/a", "example.com/a", "", undefined, null])
      expect(httpHref(u as string)).toBeUndefined();
  });
});
