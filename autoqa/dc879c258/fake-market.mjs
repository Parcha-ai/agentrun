// A fake marketplace on loopback. Path prefix picks the behaviour; /toggle reads its mode from a file.
import http from "node:http";
import fs from "node:fs";
const [port, modeFile, hitsFile] = process.argv.slice(2);
const SHA = "312015b560a1bef336de88e1fe7c48936340a329";
const list = [
  { name: "code-review", title: "Code review", summary: "Bundled one, with its agentrun source", category: "engineering", tags: ["git", "Bad Tag", "git"], needs: ["GitHub"], harness: ["pi", "BAD HARNESS"], url: "/templates/code-review/", source: `github:Parcha-ai/agentrun/packages/serve/templates/code-review@${SHA}` },
  { name: "kyb", title: "KYB\u0007 with\ncontrol chars", summary: "No source: here by name", url: "//evil.example/kyb" },
  { name: "code-review", title: "Duplicate name, must be dropped" },
  { name: "Bad Name", title: "Not a package name: dropped" },
  "not an object",
  { name: "community-one", title: "Community", category: "not-a-category", source: "not a source", url: "https://evil.example/x", summary: "x".repeat(400) },
];
let hits = 0;
http.createServer((req, res) => {
  hits++; fs.writeFileSync(hitsFile, String(hits));
  const prefix = req.url.split("/")[1];
  const mode = prefix === "toggle" ? fs.readFileSync(modeFile, "utf8").trim() : prefix;
  if (!req.url.endsWith("/search.json")) { res.writeHead(404).end(); return; }
  if (mode === "ok") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list)); return; }
  if (mode === "redirect") { res.writeHead(302, { location: "https://elsewhere.example/search.json" }).end(); return; }
  if (mode === "500") { res.writeHead(500).end("boom"); return; }
  if (mode === "notjson") { res.writeHead(200).end("<html>"); return; }
  if (mode === "hang") { return; } // never answers
  res.writeHead(418).end();
}).listen(Number(port), "127.0.0.1", () => console.log("fake marketplace on", port));
