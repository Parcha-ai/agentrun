// Reads of the progress file, one at a time, each tied to the take it was asked in. A read that lands after the take started over is the old take's
// file and is dropped; a read never starts while another is in flight, so an older read cannot land after a newer one. Pure of the page: the page
// passes how to read, which take it is, and what to do with a text.
export class SerialReader {
  private inFlight = false;
  private read: () => Promise<string | undefined>;
  private generation: () => number;
  private apply: (text: string) => void;

  constructor(read: () => Promise<string | undefined>, generation: () => number, apply: (text: string) => void) {
    this.read = read;
    this.generation = generation;
    this.apply = apply;
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const asked = this.generation();
    try {
      const text = await this.read();
      // Nothing (not written yet) or failed: nothing new. A different take now: not this take's file.
      if (text === undefined || asked !== this.generation()) return;
      this.apply(text);
    } catch {
      // The stage's own failed fetch is not news.
    } finally {
      this.inFlight = false;
    }
  }
}
