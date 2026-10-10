// Fitting the stage to the window. The obsession stage is laid out for 1600x900 (the size the takes are recorded at). Live mode runs in the viewer's own browser, at whatever size it has:
// rather than re-flow dozens of fixed sizes by hand, the whole stage is scaled down (CSS zoom on the page) when the window is smaller, so the same layout, which fits at 1600x900,
// fits at 1440x900 or 1280x800 too. A window at least as big as the design is left exactly as designed (zoom 1: no property set at all).
export const DESIGN_WIDTH = 1600;
export const DESIGN_HEIGHT = 900;
/** Below this the stage would be unreadable anyway; a window this small is not a laptop. */
export const MIN_ZOOM = 0.5;

/** The zoom for a window: 1 when it is at least the designed size, else the tighter of the two ratios, to three decimals, never below MIN_ZOOM. Nonsense input is left alone (1). */
export function stageZoom(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const z = Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
  return Math.max(MIN_ZOOM, Math.round(z * 1000) / 1000);
}
