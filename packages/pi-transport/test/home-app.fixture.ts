import { createRegistry } from "@earendil-works/pi-durable";
import type { App } from "../src/home/app.ts";

/** The smallest app: a registry of its own and nothing else. */
const app: App = () => ({ registry: createRegistry() });

export default app;
