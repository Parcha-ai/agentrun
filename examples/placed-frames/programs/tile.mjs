// One tile of the zoom, computed in a box: `node tile.mjs <json>` prints one JSON line, the tile's pixels as palette indices (one byte a pixel, base64). The program holds no state,
// so a tile asked for twice answers the same.
import { HEIGHT, TILE_H, TILE_W, WIDTH, iterationsOf, window_ } from './params.mjs';

const { f, tx, ty } = JSON.parse(process.argv[2]);
const view = window_(f);
const max = iterationsOf(f);
const scale = view.width / WIDTH;
const px = Buffer.alloc(TILE_W * TILE_H);
for (let y = 0; y < TILE_H; y += 1) {
  for (let x = 0; x < TILE_W; x += 1) {
    const cr = view.x + (tx * TILE_W + x - WIDTH / 2) * scale;
    const ci = view.y + (ty * TILE_H + y - HEIGHT / 2) * scale;
    let zr = 0;
    let zi = 0;
    let n = 0;
    while (n < max && zr * zr + zi * zi <= 4) { [zr, zi] = [zr * zr - zi * zi + cr, 2 * zr * zi + ci]; n += 1; }
    px[y * TILE_W + x] = n === max ? 0 : 1 + (n % 254);
  }
}
console.log(JSON.stringify({ px: px.toString('base64'), iterations: max }));
