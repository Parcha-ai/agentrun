// read-page.ts's worker. For `workerData`, a Job: the page's markdown, posted once as { text } (with { title, links }
// when the job has a `url`, and { truncated, html_chars } when the worker cut the page), or as { error } when the
// conversion threw (a page nested past the stack, say).
import { parentPort, workerData } from "node:worker_threads";
import { TextNode } from "node-html-parser";
import { markdownOf } from "./page-markdown.js";
import { cutHtml, dropInert, mainOf, PageScan } from "./page-scan.js";

/** `html` as given (readPage drops and cuts it first), or, with `max`, dropped (its first article, main or body only,
 *  with `main`) and cut at `max` here; `url`: the page's title and links are read too. */
export type Job = { html: string; url?: string; main?: boolean; max?: number };

if (parentPort) {
  const job = workerData as Job;
  try {
    let html = job.html;
    let cut = {};
    if (job.max !== undefined) {
      const kept = dropInert(job.html);
      const picked = job.main ? mainOf(kept) : kept;
      html = cutHtml(picked, job.max);
      if (html.length < picked.length) cut = { truncated: true, html_chars: job.html.length };
    }
    let read = {};
    if (job.url !== undefined) {
      const scan = new PageScan(html, job.url, (text) => new TextNode(text).text, false);
      scan.step(Number.POSITIVE_INFINITY);
      const { title, links } = scan.result();
      read = { title, links };
    }
    parentPort.postMessage({ ...read, ...cut, text: markdownOf(html) });
  } catch (error) {
    parentPort.postMessage({ error: String((error as Error)?.message ?? error) });
  }
}
