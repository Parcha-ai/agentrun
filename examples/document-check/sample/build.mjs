// Builds the example's two PDFs from the exhibit's page images (sample.json): the pages as filed, each JPEG placed on a
// Letter page byte for byte, and the TEST COPY, where every mark of sample.json is painted white and every page carries
// the footer that says it was altered. The images are fetched from SEC EDGAR with the User-Agent EDGAR asks for (it names
// the project and its address), one a second, or read from a folder: `node build.mjs [--from <dir>]`. Each is checked by
// SHA-256 before it is used. Prints each PDF's SHA-256 for ASSETS.md.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const here = import.meta.dirname;
const sample = JSON.parse(readFileSync(join(here, 'sample.json'), 'utf8'));
const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const pages = [];
for (const page of sample.pages) {
  let bytes;
  if (from) bytes = readFileSync(join(from, page.url.split('/').at(-1)));
  else {
    const response = await fetch(page.url, { headers: { 'User-Agent': sample.user_agent } });
    if (!response.ok) throw new Error(`${page.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (sha256(bytes) !== page.sha256) throw new Error(`page ${page.page}: SHA-256 ${sha256(bytes)}, not ${page.sha256}`);
  pages.push(bytes);
}

/** A PDF of JPEG pages, each drawn over a 612 x 792 point page. */
function pdf(jpegs) {
  const { width, height } = sample.size;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  for (const jpeg of jpegs) {
    const image = objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]));
    const draw = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
    const content = objects.push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    kids.push(objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let at = chunks[0].length;
  for (const [i, body] of objects.entries()) {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    at += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

/** A page with its marks painted white, a little past each box, and the footer. */
async function altered(jpeg, page) {
  const { width, height } = sample.size;
  const boxes = Object.values(sample.marks[page] ?? {}).map(([l, t, r, b]) => `<rect x="${l - 2}" y="${t - 2}" width="${r - l + 4}" height="${b - t + 4}" fill="#fff"/>`).join('');
  const footer = `<text x="${width / 2}" y="${height - 30}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#c00000">${sample.footer}</text>`;
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes}${footer}</svg>`);
  return sharp(jpeg).composite([{ input: overlay }]).jpeg({ quality: 90 }).toBuffer();
}

const filed = pdf(pages);
const test = pdf(await Promise.all(pages.map((jpeg, i) => altered(jpeg, String(i + 1)))));
writeFileSync(join(here, sample.files.filed), filed);
writeFileSync(join(here, sample.files.test_copy), test);
console.log(`${sample.files.filed} ${filed.length} bytes sha256 ${sha256(filed)}`);
console.log(`${sample.files.test_copy} ${test.length} bytes sha256 ${sha256(test)}`);
