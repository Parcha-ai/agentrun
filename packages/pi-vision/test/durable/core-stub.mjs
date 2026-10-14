// Stands in for the core's `readMedia`, `readWithoutSetup`, `guardResult` and `pdfText` when the adapter is loaded
// through `loadDurable()`: each call goes to the test's own function on `globalThis.visionCore`, so a test states what
// the core answers and sees what the adapter passed it.
const core = (name) => {
  const fn = globalThis.visionCore?.[name];
  if (typeof fn !== "function") throw new Error(`this test gives the core no ${name}`);
  return fn;
};

export const readMedia = (...args) => core("readMedia")(...args);
export const readWithoutSetup = (...args) => core("readWithoutSetup")(...args);
export const guardResult = (...args) => core("guardResult")(...args);
export const pdfText = (...args) => core("pdfText")(...args);
