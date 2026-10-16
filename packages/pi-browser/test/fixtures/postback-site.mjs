// A WebForms-style search, as public registries run it: one form posts to itself, a search answers a table of result
// links whose href is `javascript:__doPostBack(...)` behind an onclick guard, and a result's postback answers that
// entity's details on the same URL. A page loaded as a back/forward navigation posts the form back at load with a
// navigation flag, and that postback answers the bare search form. Only POSTs carrying this site's token are logged.
import { randomUUID } from "node:crypto";
import http from "node:http";

const RESULTS = [
  { file: "5203748", name: "EXAMPLE FINANCIAL LLC" },
  { file: "5203749", name: "EXAMPLE FINANCIAL HOLDINGS LLC" },
];

const SCRIPT = `
function __doPostBack(target, argument) {
  var form = document.forms.searchForm;
  form.__EVENTTARGET.value = target;
  form.__EVENTARGUMENT.value = argument;
  form.submit();
}
function validateStatus(link) {
  return !(link && String(link.getAttribute("data-ca")).toLowerCase() === "true");
}
window.onload = function () {
  var entries = performance.getEntriesByType ? performance.getEntriesByType("navigation") : [];
  if (entries.length > 0 && entries[0].type === "back_forward") {
    document.getElementById("hdnNavigation").value = "true";
    __doPostBack("hdnNavigation", "");
  }
};`;

/** `fillerParagraphs` push the form and results below the fold. `fixedBar` covers the viewport's bottom 120 px with a
 *  bar holding its own submit button, which answers the bare form, and puts content below the results.
 *  `postbackDelayMs` holds every POST's answer that long, as a server that takes a moment does. */
export async function startPostbackSite({ fillerParagraphs = 0, fixedBar = false, postbackDelayMs = 0 } = {}) {
  const token = randomUUID();
  const posts = [];
  const page = (body) => `<!doctype html><html><head><title>Entity Search</title><script>${SCRIPT}</script></head><body>`
    + `<form name="searchForm" method="post" action="NameSearch.aspx" id="searchForm">`
    + `<input type="hidden" name="__EVENTTARGET" value=""><input type="hidden" name="__EVENTARGUMENT" value="">`
    + `<input type="hidden" name="siteToken" value="${token}">`
    + `<h1>Entity Search</h1>`
    + Array.from({ length: fillerParagraphs }, (_, i) => `<p>Search guidance, paragraph ${i + 1}.</p>`).join("")
    + `<label>Entity Name: <input type="text" name="entityName" id="entityName"></label> `
    + `<input type="submit" name="btnSubmit" value="Search" id="btnSubmit">`
    + body
    + (fixedBar
      ? Array.from({ length: 30 }, (_, i) => `<p>Terms of use, paragraph ${i + 1}.</p>`).join("")
        + `<div style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee"><input type="submit" name="btnNewSearch" value="New search" style="width:100%;height:100%"></div>`
      : "")
    + `<input type="hidden" name="hdnNavigation" id="hdnNavigation" value=""></form></body></html>`;
  const bare = () => page(`<p id="state">bare search form</p>`);
  const results = () => page(`<p id="state">search results</p><table id="tblResults"><tr><th>FILE NUMBER</th><th>ENTITY NAME</th></tr>`
    + RESULTS.map((r, i) => `<tr><td>${r.file}</td><td><a onclick="return validateStatus(this);" id="lnk${i}" data-ca="False" href="javascript:__doPostBack('rpt$ctl0${i}$lnkbtnEntityName','')">${r.name}</a></td></tr>`).join("")
    + `</table>`);
  const details = (r) => page(`<p id="state">entity details</p><h2>Entity Details</h2><p>File Number: <span id="file">${r.file}</span></p><p>Entity Name: ${r.name}</p>`);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://site");
      const answer = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
      if (url.pathname.toLowerCase() !== "/namesearch.aspx") { res.writeHead(404); res.end(); return; }
      if (req.method === "GET") return answer(bare());
      const send = (body) => (postbackDelayMs > 0 ? setTimeout(() => answer(body), postbackDelayMs) : answer(body));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (form.get("siteToken") !== token) { res.writeHead(403); res.end(); return; }
      const post = { eventTarget: form.get("__EVENTTARGET") ?? "", button: form.get("btnSubmit") ?? form.get("btnNewSearch"), navigation: form.get("hdnNavigation") ?? "" };
      posts.push(post);
      if (post.navigation === "true") return send(bare());
      const clicked = /^rpt\$ctl0(\d)\$lnkbtnEntityName$/.exec(post.eventTarget);
      if (clicked && RESULTS[Number(clicked[1])]) return send(details(RESULTS[Number(clicked[1])]));
      if (post.button === "Search") return send(results());
      return send(bare());
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/namesearch.aspx`,
    results: RESULTS,
    /** This site's POSTs, in order: event target, the submit button when one submitted, and the navigation flag. */
    posts: () => posts.slice(),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
