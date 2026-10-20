// The chat + report page: open the recording ?r= names in the gallery (or the one at ?src=), make it into the chat
// model, and draw it. The inspection viewer is the same recording at ./?r=<id>.
import type { Json, Recording } from './format.ts';
import { fetchBlob } from './blobs.ts';
import { bundledRecordings, fromUrl, openBundled } from './load.ts';
import { extractChat } from './chat-extract.ts';
import { drawChat } from './chat-view.ts';

async function chatMain(): Promise<void> {
  const root = document.getElementById('chat-root') ?? document.body;
  const params = new URLSearchParams(location.search);
  const id = params.get('r');
  const src = params.get('src');
  try {
    let recording: Recording;
    if (id) {
      const entry = (await bundledRecordings()).find((each) => each.id === id);
      if (!entry) throw new Error(`this gallery has no recording named ${id}`);
      recording = (await openBundled(entry)).recording;
    } else if (src) recording = await fromUrl(src);
    else { location.replace('./'); return; }
    const readJson = async (sha: string): Promise<Json | undefined> => {
      const url = recording.blobUrl(sha);
      if (!url) return undefined;
      // A read that fails says why (the page then tells the reader); it is never just an absence.
      const response = await fetchBlob(url).catch((error: unknown) => { throw new Error(`it could not be fetched (${String((error as Error)?.message ?? error).slice(0, 60)})`); });
      if (!response.ok) throw new Error(`the blob answered ${response.status}`);
      return (await response.json().catch(() => { throw new Error('the blob is not JSON'); })) as Json;
    };
    drawChat(root, await extractChat(recording, readJson), recording);
  } catch (error) {
    const note = document.createElement('p');
    note.className = 'chat-error';
    note.textContent = `This recording could not be opened: ${error instanceof Error ? error.message : String(error)}`;
    root.replaceChildren(note);
  }
}

if (typeof document !== 'undefined') void chatMain();
