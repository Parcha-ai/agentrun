// What the tab app reports about a policy coming home, as narration lines with the right basis. The tab measures two times
// on its own clock (arrival to installed, arrival to walking); everything else it reports is either the simulation's
// arithmetic (mean speed over simulated seconds) or what the policy FILE says about itself (its host, its training seconds).
// A mode change (the getup network) is simulation arithmetic too. Each kind of number gets its own note, so a caption never tags a simulated or reported number as measured.
import type { Note, TabToShell } from "../types.ts";

export function notesFromTabEvent(m: TabToShell, at: number): Note[] {
  const note = (text: string, extra: Partial<Note> = {}): Note => ({ at, kind: "home", text, origin: "tab", ...extra });
  switch (m.type) {
    case "policy-arrived": {
      const out = [note(`Policy installed in the walking creature in ${Math.round(m.arrival_to_installed_ms)} ms (timed in the tab).`, { measured: true })];
      // The tab's own toast: it quotes the file's provenance ("from modal after 229 s of training"), which the tab did not observe.
      out.push(note(m.message, { basis: "reported" }));
      if (m.switched_body) out.push(note(`The tab switched to the ${m.switched_body} body to fit the policy.`));
      return out;
    }
    case "policy-walked": {
      const out: Note[] = [];
      if (m.arrival_to_walking_ms !== null) out.push(note(`Walking ${Math.round(m.arrival_to_walking_ms)} ms after the policy arrived (timed in the tab).`, { measured: true }));
      else out.push(note(m.fell ? "The creature fell before it walked off." : "The creature did not walk off in time."));
      if (m.mean_speed !== null) out.push(note(`Mean speed ${m.mean_speed.toFixed(2)} m/s over ${m.window_seconds} simulated seconds${m.fell ? ", and it fell" : ""}.`, { basis: "simulated" }));
      return out;
    }
    case "mode-changed": {
      // The getup network driving or handing back: simulated time and uprightness, the tab's own arithmetic, never wall time.
      const when = `${m.t.toFixed(1)} s of simulated time`;
      return [
        note(
          m.mode === "getup"
            ? `The creature went down (torso upright ${m.up.toFixed(2)}) and the getup network took over at ${when}.`
            : `Back on its feet (torso upright ${m.up.toFixed(2)}) and walking again at ${when}.`,
          { basis: "simulated" },
        ),
      ];
    }
    case "policy-refused":
      return [note(`Policy refused: ${m.reason}`)];
    default:
      return [];
  }
}
