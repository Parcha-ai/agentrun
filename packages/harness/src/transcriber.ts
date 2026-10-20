// The host's speech-to-text model for `vision.transcribe`, chosen by its config (the environment the demo declares), never by the agent: the key is read here, at each request, and lives in the adapter alone; the sandbox
// holds no key. Which one: `TRANSCRIBE_BASE_URL` with `TRANSCRIBE_API_KEY` (a pass-through that takes a bearer key, such as a broker's fal route), else `FAL_KEY` (fal, `Authorization: Key`), else `ELEVENLABS_API_KEY`,
// else `OPENAI_API_KEY` (whisper-1, the one OpenAI model that gives word times). None set: no transcriber, and `vision.transcribe` says so as a miss.
import { elevenLabsTranscriber, falTranscriber, openAiTranscriber } from '@parcha/pi-vision/transcribers';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';

export function transcriberFromEnv(env: NodeJS.ProcessEnv): VisionAdapterOptions['transcriber'] {
  const read = (name: string) => () => env[name];
  if (env.TRANSCRIBE_BASE_URL && env.TRANSCRIBE_API_KEY) return falTranscriber({ apiKey: read('TRANSCRIBE_API_KEY'), queueUrl: env.TRANSCRIBE_BASE_URL, auth: 'bearer' });
  if (env.FAL_KEY) return falTranscriber({ apiKey: read('FAL_KEY'), auth: 'key' });
  if (env.ELEVENLABS_API_KEY) return elevenLabsTranscriber({ apiKey: read('ELEVENLABS_API_KEY') });
  if (env.OPENAI_API_KEY) return openAiTranscriber({ apiKey: read('OPENAI_API_KEY') });
  return undefined;
}
