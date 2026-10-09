// node scripts/shot.mjs <url> <out.png> [waitMs] [evalExpr]
import { openTab, sleep } from "./cdp.mjs";
const [url, out, wait = "3000", expr] = process.argv.slice(2);
const tab = await openTab(url);
try {
  await sleep(Number(wait));
  if (expr) console.log("eval:", JSON.stringify(await tab.eval(expr)));
  await tab.screenshot(out);
  for (const l of tab.logs) console.log(l);
  console.log("saved", out);
} finally {
  await tab.close();
}
