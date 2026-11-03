// Preloaded into a run's process (NODE_OPTIONS=--import): its clock starts at DATE_LINE_NOW and runs on from there as
// the real one does. A run that resumes on a later day, without waiting for one. Without DATE_LINE_NOW it does nothing.
const at = Date.parse(process.env.DATE_LINE_NOW ?? "");
if (Number.isFinite(at)) {
  const Real = Date;
  const offset = at - Real.now();
  const now = () => Real.now() + offset;
  globalThis.Date = new Proxy(Real, {
    // `new Date()` is now; a date given its time stays that time.
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
    apply: () => new Real(now()).toString(),
    get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
  });
}
