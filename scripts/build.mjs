#!/usr/bin/env node

// Copies the shared runtime into each plugin's scripts directory. Both hosts
// copy an installed plugin out of this repository, so every plugin directory
// has to be self-contained; tests/build.test.mjs fails when a copy drifts.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TARGETS = [
  { backend: "codex", scripts: "plugins/codex-review/skills/codex-review/scripts" },
  { backend: "claude", scripts: "plugins/claude-review/skills/claude-review/scripts" }
];

export function copies() {
  return TARGETS.flatMap((target) => [
    { from: "src/runtime.mjs", to: `${target.scripts}/runtime.mjs` },
    { from: `src/backends/${target.backend}.mjs`, to: `${target.scripts}/backends/${target.backend}.mjs` }
  ]);
}

export function staleCopies() {
  return copies().filter((copy) => {
    const destination = path.join(ROOT, copy.to);
    if (!fs.existsSync(destination)) return true;
    return fs.readFileSync(path.join(ROOT, copy.from), "utf8") !== fs.readFileSync(destination, "utf8");
  });
}

export function build() {
  for (const copy of copies()) {
    const destination = path.join(ROOT, copy.to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, copy.from), destination);
  }
  return copies();
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  for (const copy of build()) process.stdout.write(`${copy.from} -> ${copy.to}\n`);
}
