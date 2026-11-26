#!/usr/bin/env node
// Render the Android icon/splash sources from res/brain2-icon.svg into app/assets/,
// then run `npx @capacitor/assets generate --android` (see app/package.json "android:icons").
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "app/package.json"));
const sharp = require("sharp");

// The SVG colors are CSS variables with defaults (orange theme); the rasterizer needs plain colors.
const svg = readFileSync(resolve(root, "res/brain2-icon.svg"), "utf8").replace(/var\(--[\w-]+,\s*([^)]+)\)/g, "$1");
const BG = "#EA580C";
const out = resolve(root, "app/assets");
mkdirSync(out, { recursive: true });

// Full icon (rounded orange square) for legacy launchers.
await sharp(Buffer.from(svg), { density: 300 }).resize(1024, 1024).png().toFile(resolve(out, "icon-only.png"));

// Adaptive icon: the monogram alone, shrunk into Android's safe zone, over a flat orange layer.
const monogram = svg.replace(/<rect class="b2-bg"[^>]*\/>/, "");
const mark = await sharp(Buffer.from(monogram), { density: 300 }).resize(640, 640).png().toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: mark, gravity: "center" }])
  .png()
  .toFile(resolve(out, "icon-foreground.png"));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } }).png().toFile(resolve(out, "icon-background.png"));

// Splash: icon centered on the app's dark background.
const splashIcon = await sharp(Buffer.from(svg), { density: 300 }).resize(512, 512).png().toBuffer();
for (const name of ["splash.png", "splash-dark.png"]) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: "#1e1e1e" } })
    .composite([{ input: splashIcon, gravity: "center" }])
    .png()
    .toFile(resolve(out, name));
}
console.log("Android icon sources written to app/assets/");
