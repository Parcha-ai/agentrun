import { useState, type ReactNode } from "react";
import { Field, Input } from "@/components/ui/field";
import { type PickerOption, Picker } from "@/components/ui/picker";
import { Switch } from "@/components/ui/switch";
import { contextSize, harnessDefault, harnessFree, harnessModels, type HarnessInfo, modelLabel, NO_DEFAULT } from "@/lib/models";

/** The Model picker's value for "type a model": a model id always has a provider and a slash (the save's own rule), so no
 *  id can be this. */
const CUSTOM_MODEL = "custom";

/** What the Model field keeps between renders: whether the person picked Custom (the box shows too for any model the
 *  harness's list lacks), and whether Free only narrows the list. Its form owns it, so it outlives the field (a step
 *  change in the editor draws the field anew). */
export type ModelFieldState = { customPicked: boolean; setCustomPicked: (on: boolean) => void; freeOnly: boolean; setFreeOnly: (on: boolean) => void };
export function useModelField(): ModelFieldState {
  const [customPicked, setCustomPicked] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  return { customPicked, setCustomPicked, freeOnly, setFreeOnly };
}

/** What the server said of a model, with the harness and model it was said of. The words depend on both ("On pi, a model
 *  is ..."), so the field shows them only while the form names that same harness and model. */
export type ModelSaid = { harness: string; model: string | undefined; text: ReactNode | undefined };

/** An agent's Model, as the editor and the API playground's agent requests name it: a picker of the models the server
 *  offers for `harness` (capabilities' harnesses[].models, each in the form that harness takes here), the server default
 *  first and Custom... last, which opens a free-text box so any model the server runs can still be named. `model`
 *  undefined is the server default. `error` and `warning`: what the server said of the model at a save, at the field
 *  while the form's harness and model are the ones it was said of. */
export function ModelField({ id, harness, model, onModel, harnesses, routePrefix, state, error, warning }: {
  id?: string; harness: string; model: string | undefined; onModel: (model: string | undefined) => void; harnesses: readonly HarnessInfo[]; routePrefix?: string | null;
  state: ModelFieldState; error?: ModelSaid | null; warning?: ModelSaid | null;
}) {
  const { customPicked, setCustomPicked, freeOnly, setFreeOnly } = state;
  const now = (said: ModelSaid | null | undefined) => (said && said.harness === harness && said.model === model ? said.text : undefined);
  // The model a definition that names none runs on, for this harness, as a person reads it: the gateway's routing prefix
  // off, the full id in a title.
  const fallback = harnessDefault(harness, harnesses);
  const modelDefault = fallback ? modelLabel(fallback, routePrefix) : undefined;
  // The picker lists what the server offers for this harness (harnesses[].models); a model it does not list, or Custom
  // picked, shows the free-text box.
  const offered = harnessModels(harness, harnesses);
  const customModel = customPicked || (model !== undefined && !offered.includes(model));
  // The free ones (harnesses[].free_models: a catalog price of all zeros) are tagged with their context size, and Free only
  // narrows the list to them; the default and Custom stay, and so does the model picked.
  const free = harnessFree(harness, harnesses);
  const listed = freeOnly && free.size ? offered.filter((m) => free.has(m) || m === model) : offered;
  const options: PickerOption[] = [{ value: "", label: modelDefault ? `Server default (${modelDefault.text})` : "Server default" }, ...listed.map((m) => ({ value: m, label: modelLabel(m, routePrefix).text, ...(free.has(m) ? { tag: `Free · ${contextSize(free.get(m)!.context_window)} context` } : {}) })), { value: CUSTOM_MODEL, label: "Custom..." }];
  return (
    <Field label="Model" id={id} optional note={modelDefault ? <>Empty uses the server's default (<span title={modelDefault.title}>{modelDefault.text}</span>).</> : NO_DEFAULT} error={now(error)} warning={now(warning)}>
      <Picker id={id} label="Model" className="w-full" value={customModel ? CUSTOM_MODEL : model ?? ""} options={options}
        onChange={(v) => {
          // Custom keeps what is typed (or picked) so far; a listed model or the default closes the box.
          if (v === CUSTOM_MODEL) { setCustomPicked(true); return; }
          setCustomPicked(false); onModel(v || undefined);
        }} />
      {customModel && <Input id={id ? `${id}-custom` : undefined} aria-label="Custom model" className="mt-2" value={model ?? ""} onChange={(e) => { setCustomPicked(true); onModel(e.target.value || undefined); }} placeholder="provider/model" />}
      {free.size > 0 && (
        <label className="mt-2 flex items-center gap-2 text-small text-muted-foreground">
          <Switch checked={freeOnly} onChange={setFreeOnly} label="Free models only" /> Free models only ({free.size}): $0 a request; the provider limits requests per day.
        </label>
      )}
    </Field>
  );
}
