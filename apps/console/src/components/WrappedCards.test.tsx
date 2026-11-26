import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardPicture, wrappedCards } from "./WrappedCards";
import { renderCard, toPng } from "@/lib/cardImage";

// jsdom draws no canvas: toPng (cardImage.test.ts covers it in its own terms) answers what each test says.
vi.mock("@/lib/cardImage", async (actual) => ({ ...(await actual<typeof import("@/lib/cardImage")>()), toPng: vi.fn() }));
import { toBody } from "@/lib/wrappedCardBodies";
import { WRAPPED_CARDS } from "@/lib/wrappedCards";
import type { Wrapped } from "@/lib/v2";

// The Wrapped page's card renderer: each card it may draw as an <img> of renderCard's data URL, its words as the alt.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.mocked(toPng).mockReset(); });

const YEAR: Wrapped = {
  year: 2025, sessions: 12, turns: 40, requests: 300, tokens: { input: 1_000_000, output: 200_000, cache_read: 5_000_000, cache_write: 100_000 },
  cost_usd: 42.5, unpriced_requests: 3, unread_files: 0, cache: null, secrets: null,
  days: [{ day: "2025-03-02", requests: 100, tokens: 4_000_000 }, { day: "2025-03-03", requests: 200, tokens: 2_300_000 }],
  hours: Array.from({ length: 24 }, (_, h) => (h === 14 ? 120 : 4)), weekdays: [0, 200, 100, 0, 0, 0, 0], active_ms: 7_200_000,
  harnesses: [{ harness: "claude-agent", sessions: 10, requests: 250, tokens: 6_000_000, sources: ["claude-code"] }],
  models: [{ model: "anthropic/claude-sonnet", requests: 250, tokens: 6_000_000, cost_usd: 42.5, unpriced_requests: 3 }],
  sources: [], imported: [],
};

function mount(node: ReactNode) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(node));
}

describe("wrappedCards", () => {
  it("draws a card as an img of its rendered SVG, at the card's size, its words as the alt", () => {
    const cover = WRAPPED_CARDS.find((c) => c.id === "cover")!;
    const image = renderCard(toBody(cover, YEAR)!);
    mount(createElement("div", null, wrappedCards(cover, YEAR, false)));
    const img = document.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(image.dataUrl);
    expect(img.getAttribute("src")!.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(img.getAttribute("alt")).toBe(image.alt);
    expect(img.getAttribute("alt")).toContain("Your 2025 in agents. 6.3M tokens. Sessions: 12");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["1200", "675"]);
  });

  it("draws the cards whose waits are met and nothing for the rest, or for an empty year", () => {
    const drawn = WRAPPED_CARDS.filter((c) => wrappedCards(c, YEAR, false) !== null).map((c) => c.id);
    expect(drawn).toEqual(["cover", "split", "hours", "summary"]);
    for (const c of WRAPPED_CARDS) expect(wrappedCards(c, { ...YEAR, sessions: 0 }, true), c.id).toBeNull();
    // The leak receipt only once the person turned the opt-in cards on, and only for a year whose keys were counted.
    const counted = { ...YEAR, secrets: { runs: 4, runs_holding: 1, removed: 2 } };
    expect(WRAPPED_CARDS.filter((c) => wrappedCards(c, counted, false) !== null).map((c) => c.id)).toEqual(["cover", "split", "hours", "summary"]);
    expect(WRAPPED_CARDS.filter((c) => wrappedCards(c, counted, true) !== null).map((c) => c.id)).toEqual(["cover", "split", "hours", "leak", "summary"]);
    expect(WRAPPED_CARDS.filter((c) => wrappedCards(c, YEAR, true) !== null).map((c) => c.id)).toEqual(["cover", "split", "hours", "summary"]);
  });

  it("CardPicture shows any body's image with its alt, and offers no download without a file name", () => {
    mount(createElement(CardPicture, { body: { title: "Just a title" } }));
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("Just a title");
    expect(document.querySelector("button")).toBeNull();
  });

  it("each drawn card downloads as a PNG named for its year and card, drawn from the image shown", async () => {
    const split = WRAPPED_CARDS.find((c) => c.id === "split")!;
    const png = new Blob(["png"], { type: "image/png" });
    vi.mocked(toPng).mockResolvedValue(png);
    const made = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:card");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saved: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push({ href: this.href, download: this.download }); });
    mount(createElement("div", null, wrappedCards(split, YEAR)));
    const button = document.querySelector("button")!;
    expect(button.textContent).toBe("Download PNG");
    expect(button.getAttribute("aria-label")).toBe("Download the Harnesses and models card as a PNG");
    await act(async () => button.click());
    expect(vi.mocked(toPng)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toPng).mock.calls[0]![0].dataUrl).toBe(document.querySelector("img")!.getAttribute("src"));
    expect(made).toHaveBeenCalledWith(png);
    expect(saved).toEqual([{ href: "blob:card", download: "wrapped-2025-split.png" }]);
    expect(revoked).toHaveBeenCalledWith("blob:card");
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("a card the browser cannot draw as a PNG says so beside its button, and nothing is saved", async () => {
    vi.mocked(toPng).mockRejectedValue(new Error("this browser draws no canvas"));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mount(createElement("div", null, wrappedCards(WRAPPED_CARDS.find((c) => c.id === "cover")!, YEAR)));
    await act(async () => document.querySelector("button")!.click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe("This card could not be saved as a PNG: this browser draws no canvas.");
    expect(click).not.toHaveBeenCalled();
  });
});
