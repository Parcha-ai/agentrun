// The one palette of the zoom: a tile is stored as palette indices (one byte a pixel), and the result's picture maps them through this file. Index 0 is inside the set
// (black); the others sweep the hue.
export const rgbOf = (index) => {
  if (index === 0) return [0, 0, 0];
  const hue = ((index * 11) % 360) / 60;
  const x = 1 - Math.abs((hue % 2) - 1);
  const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(hue) % 6];
  const shade = 0.35 + 0.65 * (1 - Math.min(index, 255) / 330);
  return [Math.round(255 * r * shade), Math.round(255 * g * shade), Math.round(255 * b * shade)];
};
