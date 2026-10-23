// The runs server's page: the run page over the server's own routes, wherever the page is served from.
import { mountRunPage } from "./run-page.js";
import { httpSource } from "./source.js";

mountRunPage(document.getElementById("app"), httpSource(new URL("./", location.href).href));
