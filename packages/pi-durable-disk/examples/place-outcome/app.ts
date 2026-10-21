// The app a place's instance runs (`pi-durable-disk run --app app.ts`): one turn of pi-ai's faux model, then the run's last
// word. An app that wants its supervisor to have its result puts it in that last status: `record` is the result, `models`
// the models it used, and a run that gives up says why in `code` and `message`.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AppOptions } from "@parcha/pi-durable-disk";

export default function app(): AppOptions {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("The invoice total is 42.")));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return {
    models,
    registry: createRegistry(),
    async onOpen(run) {
      const chat = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
      await (await chat.submit({ type: "input", content: "Total the invoice", requestId: "job-1" }, ctx)).wait(ctx);
      const used = { lead: model.id };
      if (process.env.GIVE_UP) await run.setStatus("failed", { code: "GAVE_UP", message: "no total could be made", models: used });
      else await run.setStatus("done", { record: { total: 42 }, models: used });
      await run.release();
      process.exit(0);
    },
  };
}
