// Read a PDF with web_fetch. A fetch service that converts pages to markdown often cannot convert a PDF (Browserbase
// answers HTTP 400). web_fetch then fetches the file raw and hands its bytes to the host's extractor: here poppler's
// pdftotext. The stand-in service below serves one PDF from a local server and answers 400 for it, as Browserbase does.
import { execFile } from "node:child_process";
import http from "node:http";
import { createWebTools } from "@parcha/pi-browser";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 50 Td (Invoice 4471 is due) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n");
const server = http.createServer((_req, res) => { res.setHeader("content-type", "application/pdf"); res.end(pdf); }).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const service = async ({ url, format }) => {
  if (format !== "raw") throw Object.assign(new Error("HTTP 400"), { status: 400 });
  return { finalUrl: url, statusCode: 200, contentType: "application/pdf", content: Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64") };
};
const pdftotext = (bytes) => new Promise((resolve, reject) => { const p = execFile("pdftotext", ["-", "-"], (error, out) => (error ? reject(error) : resolve(out))); p.stdin.end(bytes); });
const web = createWebTools({ name: "demo", fetch: service, pdf: { text: pdftotext }, evidence: { file: async () => null }, scope: () => ({ label: "demo", proxies: false }) });
const result = await web.fetch("demo", { url: `http://127.0.0.1:${server.address().port}/invoice.pdf` });
console.log(result.text);
server.close();
