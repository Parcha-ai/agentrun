// The hash changes before the console handles its route event. Force that gap: the departing agent RunBar has the
// same message placeholder as the destination Playground, so a URL alone cannot prove which form receives input.
import templateUnattended from "./template-unattended.mjs";

export default {
  ...templateUnattended,
  name: "template-unattended-navigation",
  async run(args) {
    const { page } = args;
    let misplaced, delayed = false;
    const wrongForm = new Promise((_, reject) => { misplaced = reject; });
    await page.exposeBinding("templateNavigationInput", (_source, region) => {
      if (region === "Start a run") misplaced(new Error("The playground request was typed into the departing agent's RunBar."));
    });
    await page.exposeBinding("templateNavigationHeld", () => { delayed = true; });
    const holdNavigation = () => {
      let held = false, resuming = false;
      window.addEventListener("hashchange", (event) => {
        if (resuming || !location.hash.startsWith("#/playground?agent=")) return;
        event.stopImmediatePropagation();
        if (held) return;
        held = true;
        void window.templateNavigationHeld();
        // Fault injection only: delay event delivery, without changing the flow's action or response deadlines.
        setTimeout(() => {
          resuming = true;
          window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: event.oldURL, newURL: event.newURL }));
        }, 1000);
      }, true);
      document.addEventListener("input", (event) => {
        if (held && !resuming && event.target instanceof HTMLTextAreaElement)
          void window.templateNavigationInput(event.target.closest("section")?.getAttribute("aria-label"));
      }, true);
    };
    await page.addInitScript(holdNavigation);
    // Install before the router registers its listener; the signed-in browser session survives this reload.
    await page.reload();
    await Promise.race([templateUnattended.run(args), wrongForm]);
    if (!delayed) throw new Error("The delayed playground navigation was never exercised.");
  },
};
