// A stub canvas that lets the real Sketcher run in node: it records the listeners so a test can press, move and release.
export function fakeCanvas(width = 800, height = 800) {
  const listeners: Record<string, (e: any) => void> = {};
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas: any = {
    clientWidth: width, clientHeight: height, width, height, style: {},
    getContext: () => ctx,
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    setPointerCapture: () => {},
  };
  (globalThis as any).devicePixelRatio ??= 1;
  return { canvas, fire: (type: string, p: { x: number; y: number }) => listeners[type]?.({ clientX: p.x, clientY: p.y, pointerId: 1 }) };
}
