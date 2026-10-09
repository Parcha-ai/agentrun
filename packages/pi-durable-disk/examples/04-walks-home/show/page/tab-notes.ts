// What the tab app reports about a policy coming home, as narration lines with the right basis. The tab measures two times
// on its own clock (arrival to installed, arrival to walking); everything else it reports is either the simulation's
// arithmetic (mean speed over simulated seconds) or what the policy FILE says about itself (its host, its training seconds).
// A mode change (the getup network) is simulation arithmetic too. Each kind of number gets its own note, so a caption never tags a simulated or reported number as measured.
import type { Note, TabToShell } from "../types.ts";
import { bandOf, lessonFor, type Band } from "./lessons.ts";

export type TabNoteOptions = {
  /** The v2 stage's plain words: one short sentence per event, the debug log's technical detail left out. */
  plain?: boolean;
  /** Whether the install a `policy-walked` is about was a checkpoint from the live training path or the final home policy (the page remembers it from the arrival). */
  kind?: "checkpoint" | "final";
  /** For a checkpoint's walk: the band its arrival was in (from the file's reported distance), so a walk is captioned only when it is walking. */
  band?: Band | null;
};

/** Seconds as people say them: whole, or to a tenth. A simulated clock gives 1.999999999999602; the page says 2. */
const secs = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/**
 * A refusal's own reason is a developer's sentence ("could not fetch /policy/home.json: HTTP 404", "mjcf_sha256 differs"). In plain words the viewer
 * gets what happened and what it means, by kind; the debug log keeps the tab's own words. The kinds are the tab's (arrival.ts): a file that
 * could not be loaded, one that is not in a usable form, one trained for another body.
 */
export function plainRefusal(reason: string): string {
  if (/trained for a body|different body|mjcf|sha256 differs/i.test(reason) && !/missing or malformed/i.test(reason)) return "That brain was trained for a different body, so the tab did not use it.";
  if (/could not fetch|fetch|HTTP \d|network/i.test(reason)) return "The new brain could not be loaded, so the creature kept what it had.";
  if (/not valid JSON|not a policy|unknown format|unknown spec_version|missing or malformed|not finite|NaN|too large|size/i.test(reason)) return "The brain file was damaged or in the wrong form, so the tab did not use it.";
  return "The tab could not use that brain.";
}

const metres = (m: Extract<TabToShell, { type: "policy-walked" }>) => (m.mean_speed === null ? null : m.mean_speed * m.window_seconds);

export function notesFromTabEvent(m: TabToShell, at: number, opts: TabNoteOptions = {}): Note[] {
  const note = (text: string, extra: Partial<Note> = {}): Note => ({ at, kind: "home", text, origin: "tab", ...extra });
  const plain = opts.plain === true;
  switch (m.type) {
    case "policy-arrived": {
      // A checkpoint from the GPU, in plain words. Everything in it is what the file says about itself, so it is REPORTED; the tab's
      // own install time is not worth a caption for every checkpoint.
      if (plain && m.kind === "checkpoint") {
        const which = m.checkpoint_n !== undefined ? `Version ${m.checkpoint_n}` : "A new version";
        // The lesson this checkpoint teaches, read from the distance its own file reports (REPORTED): no lesson for a file that reports none.
        const band = bandOf(m.reported_walk_10s_m);
        if (band !== null) {
          const lesson = lessonFor(band);
          return lesson ? [note(`${which}: ${lesson}`, { basis: "reported" })] : [];
        }
        return [note(`${which} of its brain arrived from the GPU${m.wall_s != null ? `, after ${Math.round(m.wall_s)} s of training` : ""}.`, { basis: "reported" })];
      }
      // The trained brain coming home, in plain words: when it was installed (the tab's own clock) and how long it trained (what the file says).
      if (plain) {
        const home = [note(`The trained brain was installed in your browser in ${Math.round(m.arrival_to_installed_ms)} ms (timed in the tab).`, { measured: true })];
        if (m.training_seconds != null) home.push(note(`It trained for ${Math.round(m.training_seconds)} s before coming home.`, { basis: "reported" }));
        if (m.switched_body) home.push(note(`The creature changed to the ${m.switched_body} body to fit the new brain.`));
        return home;
      }
      const out = [note(`Policy installed in the walking creature in ${Math.round(m.arrival_to_installed_ms)} ms (timed in the tab).`, { measured: true })];
      // The tab's own toast: it quotes the file's provenance ("from modal after 229 s of training"), which the tab did not observe.
      out.push(note(m.message, { basis: "reported" }));
      if (m.switched_body) out.push(note(`The tab switched to the ${m.switched_body} body to fit the policy.`));
      return out;
    }
    case "policy-walked": {
      if (plain) {
        const distance = metres(m);
        // A walk that ran its whole window and never walked off is an internal state, not something to caption.
        if (m.outcome === "not-walking") return [];
        const who = opts.kind === "checkpoint" ? (m.checkpoint_n !== undefined ? `Version ${m.checkpoint_n}` : "This version") : "The creature";
        // The tab's simulation, not wall time: how far it got in the seconds it really ran (fewer than 10 when the next checkpoint landed first).
        // A checkpoint whose file reported its distance has told its lesson already: only a walking one gets a line for how far it went.
        if (opts.kind === "checkpoint" && opts.band !== undefined && opts.band !== null && opts.band !== "walk") return [];
        if (m.fell) return [note(`${who} fell over within ${secs(m.window_seconds)} s.`, { basis: "simulated" })];
        if (distance === null) return [];
        const how = `${distance.toFixed(1)} m in ${secs(m.window_seconds)} s`;
        const n = m.checkpoint_n !== undefined ? ` (version ${m.checkpoint_n})` : "";
        const text = opts.kind === "checkpoint" ? (opts.band === "walk" ? `Walking: ${how}${n}.` : `Learning on the GPU: walked ${how}${n}.`) : `In your browser it walks ${how}.`;
        const out = [note(text, { basis: "simulated" })];
        // At home the time the tab took to walk off is its own measurement; a checkpoint's is not worth a caption.
        if (opts.kind !== "checkpoint" && m.arrival_to_walking_ms !== null) out.unshift(note(`It was walking ${Math.round(m.arrival_to_walking_ms)} ms after the new brain arrived (timed in the tab).`, { measured: true }));
        return out;
      }
      const out: Note[] = [];
      if (m.arrival_to_walking_ms !== null) out.push(note(`Walking ${Math.round(m.arrival_to_walking_ms)} ms after the policy arrived (timed in the tab).`, { measured: true }));
      // Why there is no time is the tab's own `outcome` when it says (a null is "not measured", not "failed"); an older tab is read from `fell`.
      else if (m.outcome === "cut-short") out.push(note("The next checkpoint arrived before this one's test was over."));
      else out.push(note(m.fell || m.outcome === "fell" ? "The creature fell before it walked off." : "The creature did not walk off in time."));
      if (m.mean_speed !== null) out.push(note(`Mean speed ${m.mean_speed.toFixed(2)} m/s over ${secs(m.window_seconds)} simulated seconds${m.fell ? ", and it fell" : ""}.`, { basis: "simulated" }));
      return out;
    }
    case "stood-up":
      return [note("A new version of its brain arrived while it was lying down, and it stood back up.")];
    case "mode-changed": {
      if (plain) return [note(m.mode === "getup" ? "It was down. It learned to get back up." : "Back on its feet and walking again.")];
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
      return [note(plain ? plainRefusal(m.reason) : `Policy refused: ${m.reason}`)];
    default:
      return [];
  }
}
