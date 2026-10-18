// The zoom's geometry, one place: a frame is `TILES_X` by `TILES_Y` tiles of `TILE_W` by `TILE_H` pixels, drawn at frame `f` of the dive into the seahorse valley.
export const TILE_W = 96;
export const TILE_H = 54;
export const TILES_X = 2;
export const TILES_Y = 2;
export const WIDTH = TILE_W * TILES_X;
export const HEIGHT = TILE_H * TILES_Y;
const CENTER = { x: -0.743643887037151, y: 0.13182590420533 };
const START_WIDTH = 3.0;
const RATIO = 0.55;
/** The complex-plane window of frame `f`: its centre, and its width (the height follows the aspect). */
export const window_ = (f) => ({ ...CENTER, width: START_WIDTH * RATIO ** f });
export const iterationsOf = (f) => 80 + 10 * f;
