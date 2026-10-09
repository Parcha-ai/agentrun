// The live desktop of the machine the agent is on, shown while the run is on a VM (D4's view-only picture). The page asks the
// stage server for a ticket path and points an <img> at it: the secret behind the ticket never reaches the page. Nothing
// here is the page's to decide beyond "the run is on a VM, show it if the host has one".
import type { ShowState } from "../types.ts";

const RETRY_MS = 3000;
/** Tickets live 10 minutes; ask again well before. */
const REFRESH_MS = 8 * 60_000;

export class DesktopView {
  private root: HTMLElement;
  private img: HTMLImageElement;
  private note: HTMLElement;
  private label: HTMLElement;
  private key = "";
  private url = "";
  private pending = false;
  private nextTry = 0;
  private ticketAt = 0;
  /** The server said it has no desktop configured at all: stop asking. */
  private off = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.img = root.querySelector("img")!;
    this.note = root.querySelector(".dnote")!;
    this.label = root.querySelector(".dhost")!;
    // A broken picture (the host's stream ended, the ticket expired): drop it and ask again.
    this.img.addEventListener("error", () => this.drop(RETRY_MS));
  }

  private drop(retryIn: number): void {
    this.url = "";
    this.img.removeAttribute("src");
    this.img.hidden = true;
    this.note.hidden = false;
    this.nextTry = performance.now() + retryIn;
  }

  /** Called every frame: show, hide or refresh the desktop for what the feed says now. */
  update(state: ShowState): void {
    const env = state.environments.find((e) => e.id === state.currentEnv);
    const wanted = !this.off && env?.kind === "vm";
    if (!wanted) {
      if (!this.root.hidden) {
        this.root.hidden = true;
        // Closing the picture closes the proxied stream, so the host stops taking screenshots for nobody.
        this.url = "";
        this.img.removeAttribute("src");
        this.key = "";
      }
      return;
    }
    const key = `${env!.id}|${"host" in state.place ? state.place.host : ""}`;
    this.root.hidden = false;
    this.label.textContent = "host" in state.place && state.place.host ? state.place.host : env!.label;
    if (key !== this.key) {
      // A different machine: a different picture.
      this.key = key;
      this.drop(0);
    }
    const now = performance.now();
    if (this.url && now - this.ticketAt > REFRESH_MS) this.drop(0);
    if (!this.url && !this.pending && now >= this.nextTry) void this.request();
  }

  private async request(): Promise<void> {
    this.pending = true;
    try {
      const res = await fetch("/api/desktop", { cache: "no-store" });
      if (res.ok) {
        const { url } = (await res.json()) as { url: string };
        this.url = url;
        this.ticketAt = performance.now();
        this.note.hidden = true;
        this.img.hidden = false;
        this.img.src = url;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      if (body.reason === "not configured") {
        this.off = true;
        this.root.hidden = true;
        return;
      }
      this.note.textContent = "The desktop is not up yet.";
      this.nextTry = performance.now() + RETRY_MS;
    } catch {
      this.nextTry = performance.now() + RETRY_MS;
    } finally {
      this.pending = false;
    }
  }
}
