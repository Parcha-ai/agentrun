import { defineDynamic, defineInstructions } from 'eve/instructions';
import { instructionsFor } from './lib/runtime.js';

export default defineDynamic(async ctx => {
  const content = await instructionsFor(ctx);
  return content ? defineInstructions({ content }) : null;
});
