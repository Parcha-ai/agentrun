// Uses the defaults already saved by Pi, including this trusted project's settings.
// It never chooses a replacement model or changes your saved configuration.
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

const settings = SettingsManager.create(process.cwd());
const provider = settings.getDefaultProvider();
const savedModel = settings.getDefaultModel();
if (!provider || !savedModel) {
  throw new Error('Configure and save a default in Pi first, then rerun this example. No default will be chosen for you.');
}
const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
if (modelRuntime.getError()) throw new Error('Pi could not load its configured runtime. Check your Pi configuration.');
const model = modelRuntime.getModel(provider, savedModel);
if (!model || !modelRuntime.getAvailableSnapshot().some(available => available.provider === provider && available.id === savedModel)) {
  throw new Error('Your saved Pi default is unavailable. Check its configured access in Pi; no fallback was selected.');
}
export default { modelRuntime, model, maxTurns: 8, timeoutMs: 120_000 };
