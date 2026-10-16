// A replay's page: the run page over a replay's static files, read from the `replay-data` meta tag's address
// (relative to the page; pack-page.mjs writes "./data/") and drawn in the `replay-theme` meta tag's theme (auto, light
// or dark). Nothing in a replay acts, and it shows no live browser.
import { mountRunPage } from "./run-page.js";
import { staticSource } from "./source.js";

const data = document.querySelector('meta[name="replay-data"]')?.getAttribute("content") || "./data/";
const theme = document.querySelector('meta[name="replay-theme"]')?.getAttribute("content") || "auto";
mountRunPage(document.getElementById("app"), staticSource(new URL(data, location.href).href), { theme });
