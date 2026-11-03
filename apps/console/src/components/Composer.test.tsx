import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer";
import type { MessageMode } from "@/lib/runState";

const html = (mode: MessageMode, sent = false) => renderToStaticMarkup(createElement(Composer, { mode, onSend: () => {}, sent }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// The box under every run that takes a message says what sending does in plain words: never the server's own name for
// the mode (follow_up, steer, answer), which is an API word.
describe("Composer", () => {
  it("a follow-up says what it does, with no API name", () => {
    const shown = text(html("follow_up"));
    expect(shown).toContain("Ask a follow-up · Continues this run with your message; the same spend cap applies.");
    expect(shown).not.toMatch(/follow_up|new turn/);
  });

  it("each mode is named in plain words, and none shows the server's name for it", () => {
    for (const [mode, says] of [
      ["steer", "Steer the run · The agent reads it when its current step ends."],
      ["answer", "Answer the question · Answers what the agent asked; the run goes back to work."],
    ] as const) {
      const markup = html(mode);
      expect(text(markup)).toContain(says);
      expect(markup).not.toContain("<code");
    }
  });

  it("names the message box by what it does, so a screen reader says it too", () => {
    expect(html("follow_up")).toMatch(/<label[^>]*for="composer"[^>]*>Ask a follow-up<\/label>/);
    expect(html("answer")).toMatch(/<label[^>]*for="composer"[^>]*>Answer the question<\/label>/);
  });

  it("after a send, says it was sent and keeps the box named", () => {
    const markup = html("follow_up", true);
    expect(text(markup)).toContain("Ask a follow-up · Sent. It appears on the timeline when the run takes it.");
    expect(markup).toMatch(/<label[^>]*for="composer"[^>]*>Ask a follow-up<\/label>/);
  });
});
