// The same guards for a browser, without `node:util/types`: an async function (or async generator function) carries its
// kind in its string tag, and a native promise is an instance of the realm's Promise. Checked against Node's by
// test/browser-executor.test.mjs over the refusals the executor must give.
export const isAsyncFunction = (value: unknown): boolean => {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object AsyncFunction]" || tag === "[object AsyncGeneratorFunction]";
};
export const isPromise = (value: unknown): boolean => value instanceof Promise;
