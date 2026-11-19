// Learning's model requirement, shared by its settings view and SDK admission. This checks configured routes and
// credentials, never sends a model request, and never treats a tool/decision key as a generative model credential.
import { chooseModel, FAUX_ENV, hostModel, type ModelNeeds } from "./model.js";
import { harnessOf } from "./harness-table.js";
import { HarnessUnavailable, providerFor } from "./provider.js";
import { nativeOf } from "./native/binding.js";
import { noServerKeyFor, serverKeyMissing } from "./run-model-key.js";
import { askRouteOf } from "./runner/sdk-ask.js";
import { routeOf } from "./runner/model-route.js";
import { PI_WIRES } from "./runner/adapter-run-spec.js";
import type { AgenticBody } from "./store/agent-body.js";

export type LearningModel = {
  location: "server" | "native";
  ready: boolean;
  model: string | null;
  needs: ModelNeeds | null;
  reason: string | null;
};

/** An omitted revision describes the default SDK compile route for a server with no agents yet. Native bindings keep
 *  their original sign-in. For managed harnesses the existing model selection checks their own wire/login; SDKs need
 *  the separate server compile route, even when the original application's harness already has its own credential. */
export async function learningModelOf(env: NodeJS.ProcessEnv, revision?: { kind: string; body: unknown } | null): Promise<LearningModel> {
  const body = (revision?.body ?? {}) as AgenticBody;
  const native = nativeOf(body);
  if (native) return { location: "native", ready: true, model: native.model ?? null, needs: null,
    reason: "Uses the connected runtime's existing sign-in. Native corrections do not need a server model key; learned workflows are unavailable on this connection." };
  const notReady = (model: string | null, needs: ModelNeeds | null, reason: string): LearningModel => ({ location: "server", ready: false, model, needs, reason });
  if (revision && revision.kind !== "agentic") return notReady(null, null, "Workflow definitions do not create new learning.");
  const configured = body.model ?? hostModel(env, "default", body.harness) ?? null;
  try {
    const entry = harnessOf(env, body.harness);
    const choice = entry?.onWire(env) ? await entry.model(env, body.model, true) : await chooseModel(env, body.model, "default", body.harness);
    if (!choice) return notReady(configured, "model", "Choose a server model supported by this agent's harness in Settings → API Keys.");
    if ("why" in choice) return notReady(configured, choice.needs ?? (choice.host ? "key" : "model"), choice.why.replaceAll("Settings → Model keys", "Settings → API Keys"));
    if (!choice.model) return notReady(configured, "model", "Configure a server model in Settings → API Keys before enabling learning.");
    const model = `${choice.model.provider}/${choice.model.modelId}`;
    const needsServerKey = !env[FAUX_ENV] && (!revision || body.sdk
      ? noServerKeyFor(env, "Background learning") !== undefined
      : serverKeyMissing(env, { kind: "agentic", model: choice.model }));
    if (needsServerKey) return notReady(model, "key", "Add a server-owned model gateway key in Settings → API Keys. Background learning cannot use a caller's per-run key.");
    // Managed agents compile inside their own harness session, with that harness's model and authentication.
    // SDK agents compile separately through pi's server route. A native application's sign-in is never copied here.
    try {
      if (!revision || body.sdk) {
        const route = await askRouteOf(model, env, one => routeOf(one, env, "default", PI_WIRES));
        await route.provider.credential();
      } else if (entry?.onWire(env) && entry.facts) {
        // Wire model selection names a model even with no key. Its provider checks the actual harness login or key.
        await providerFor(entry.facts.wire, env, choice.model, entry.id).credential();
      }
    } catch (error) {
      if (error instanceof HarnessUnavailable && !error.keys?.length)
        return notReady(model, "model", `${error.message} Check the learning model and harness in Settings → API Keys.`);
      return notReady(model, "key", "Configure a model credential for this server's selected learning model in Settings → API Keys. Tool and decision-provider keys do not enable workflow compilation.");
    }
    return { location: "server", ready: true, model, needs: null, reason: null };
  } catch {
    return notReady(configured, "model", "The configured learning model could not be resolved. Check its provider, model and credentials in Settings → API Keys.");
  }
}
