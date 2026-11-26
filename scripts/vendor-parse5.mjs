// Rebuilds the copy of parse5 that the source check reads web pages with.
// The plugin ships with nothing to install, so the files its parser needs,
// from parse5 and the one package parse5 uses, are copied into the plugin as
// published. The only change is that an import of that package names its
// copy. To update, change the versions here, run `npm run vendor`, and then
// `npm run build`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT } from "./build.mjs";

const PACKAGES = { parse5: "8.1.1", entities: "9.0.0" };
const ENTRY = "parse5/parser/index.js";
// What each package import resolves to, as entities' own exports map says.
const SPECIFIERS = { "entities/decode": "entities/decode.js", "entities/escape": "entities/escape.js" };
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/g;
const VENDOR = path.join(ROOT, "plugins/cross-review/skills/cross-research/scripts/vendor");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "parse5-vendor-"));
const published = {};
for (const [name, version] of Object.entries(PACKAGES)) {
  // Only downloads the published tarball; nothing in it runs.
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", `${name}@${version}`, "--json", "--ignore-scripts", "--pack-destination", work], { encoding: "utf8" }));
  published[name] = path.join(work, name);
  fs.mkdirSync(published[name]);
  execFileSync("tar", ["-xzf", path.join(work, filename), "-C", published[name], "--strip-components=1"]);
}
const sourceOf = (file) => {
  const [name, ...rest] = file.split("/");
  return path.join(published[name], "dist", ...rest);
};

// The files the parser reaches from its entry, found by following imports.
const needed = new Map();
const pending = [ENTRY];
while (pending.length) {
  const file = pending.pop();
  if (needed.has(file)) continue;
  let text = fs.readFileSync(sourceOf(file), "utf8");
  text = text.replace(IMPORT, (statement, quote, specifier) => {
    if (specifier.startsWith(".")) {
      pending.push(path.posix.join(path.posix.dirname(file), specifier));
      return statement;
    }
    if (!SPECIFIERS[specifier]) throw new Error(`${file} imports ${specifier}, which has no copy here.`);
    pending.push(SPECIFIERS[specifier]);
    const relative = path.posix.relative(path.posix.dirname(file), SPECIFIERS[specifier]);
    return statement.replace(`${quote}${specifier}${quote}`, `${quote}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`);
  });
  needed.set(file, text);
}

// Written whole beside the copy in use, on the same disk, and then swapped
// in, so that a failure at any step leaves the copy in use as it was.
const staging = fs.mkdtempSync(path.join(path.dirname(VENDOR), ".vendor-"));
const staged = path.join(staging, "vendor");
const previous = path.join(staging, "previous");
// Looked up without following a link, since a relative one moved into the
// staging directory no longer leads where it did.
const entry = (file) => fs.lstatSync(file, { throwIfNoEntry: false });
// Whether the staging directory holds the only copy of the entry in use.
let backup = false;
try {
  for (const [file, text] of needed) {
    fs.mkdirSync(path.dirname(path.join(staged, file)), { recursive: true });
    // As published, final newline or not, so that each file compares equal to its original.
    fs.writeFileSync(path.join(staged, file), text);
  }
  for (const name of Object.keys(PACKAGES)) fs.copyFileSync(path.join(published[name], "LICENSE"), path.join(staged, name, "LICENSE"));
  // An installed plugin has no package.json above it to say these are modules.
  fs.writeFileSync(path.join(staged, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  if (entry(VENDOR)) {
    fs.renameSync(VENDOR, previous);
    backup = true;
  }
  try {
    fs.renameSync(staged, VENDOR);
  } catch (error) {
    if (backup) {
      fs.renameSync(previous, VENDOR);
      backup = false;
    }
    throw error;
  }
  backup = false;
} finally {
  if (!backup) fs.rmSync(staging, { recursive: true, force: true });
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`Copied ${needed.size} files of ${Object.entries(PACKAGES).map(([name, version]) => `${name} ${version}`).join(" and ")} into ${path.relative(ROOT, VENDOR)}.`);
