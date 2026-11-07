// The loader hooks of open-after-effect.mjs: serve's app module (dist/app.js), as the run's process loads it, with an
// open hook that waits first (openAfterEffect).
const HELD = new URL("./open-after-effect-app.mjs", import.meta.url).href;

export async function load(url, context, next) {
  if (!/\/serve\/dist\/app\.js$/.test(url)) return next(url, context);
  const app = JSON.stringify(`${url}?unheld`);
  return { format: "module", shortCircuit: true, source: `import app from ${app};\nimport { openAfterEffect } from ${JSON.stringify(HELD)};\nexport * from ${app};\nexport default async (where) => openAfterEffect(where, await app(where));\n` };
}
