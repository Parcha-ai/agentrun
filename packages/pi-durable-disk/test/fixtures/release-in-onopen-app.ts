// An app that releases the run in onOpen and returns, without exiting the process: the instance must end by itself (exit 0).
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "../../src/index.ts";

export default async function app(_where: AppContext): Promise<AppOptions> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return {
    models,
    registry: createRegistry(),
    async onOpen(run) {
      await run.setStatus("done");
      await run.release();
    },
  };
}
