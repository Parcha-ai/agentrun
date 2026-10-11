// The image processors on the synthetic images: each file fitted to the default image limits (2000 px on the long edge,
// 4.5 MiB, JPEG at quality 80), by sharp and by Photon. One cold call per file.
import sharp from "sharp";
import { DEFAULT_LIMITS } from "@parcha/pi-vision";
import { photonImages } from "@parcha/pi-vision/providers/photon";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { fixtureDir, imageSize, photoJpeg, tallPng, widePng } from "@parcha/pi-vision/testing";
import { HEADER, jobRows, sharpFactory, table, writeFiles } from "./support.mjs";

const fit = async (provider, file) => {
  const fitted = await provider.prepare(file.bytes, imageSize(file.bytes).mimeType, DEFAULT_LIMITS.image);
  if (!fitted) return { bytes: "-", pixels: "declined" };
  const data = Buffer.from(fitted.data, "base64");
  const { width, height } = imageSize(data);
  return { bytes: data.length, pixels: `${width}x${height}` };
};

const dir = await fixtureDir("pi-vision-bench-");
try {
  const files = await writeFiles(dir, {
    "tall-screenshot.png": { kind: "image", bytes: await tallPng(sharpFactory) },
    "dashboard-2x.png": { kind: "image", bytes: await widePng(sharpFactory) },
    "phone-photo.jpg": { kind: "image", bytes: await photoJpeg(sharpFactory) },
  });
  const rows = [
    ...await jobRows({ label: "sharp", job: "fit", make: () => sharpImages(sharp), cwd: dir.path, files, run: fit }),
    ...await jobRows({ label: "photon", job: "fit", make: photonImages, cwd: dir.path, files, run: fit }),
  ];
  table("image processors: fit to the default image limits", HEADER, rows);
} finally {
  await dir.remove();
}
