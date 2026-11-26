#!/usr/bin/env node
// Stamp one version everywhere before a release build: node scripts/set-version.mjs 1.2.3
// (CI passes the release tag without its leading "v").
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] || "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a semantic version: "${process.argv[2] ?? ""}" (expected e.g. 1.2.3 or v1.2.3-beta.1)`);
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edit = (rel, re, replacement) => {
  const file = resolve(root, rel);
  const text = readFileSync(file, "utf8");
  if (!re.test(text)) throw new Error(`No version found in ${rel}`);
  writeFileSync(file, text.replace(re, replacement));
  console.log(`${rel} -> ${version}`);
};
edit("app/package.json", /"version":\s*"[^"]+"/, `"version": "${version}"`);
edit("backend/pyproject.toml", /^version = "[^"]+"/m, `version = "${version}"`);
edit("backend/brain2/__init__.py", /__version__ = "[^"]+"/, `__version__ = "${version}"`);
// Android: versionName is the version, versionCode must be a growing integer.
const [maj, min, pat] = version.split(/[.-]/).map(Number);
edit("app/android/app/build.gradle", /versionName "[^"]+"/, `versionName "${version}"`);
edit("app/android/app/build.gradle", /versionCode \d+/, `versionCode ${maj * 10000 + min * 100 + pat}`);
