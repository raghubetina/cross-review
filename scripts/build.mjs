#!/usr/bin/env node

// Copies the shared runtime into each plugin's scripts directory. Both hosts
// copy an installed plugin out of this repository, so every plugin directory
// has to be self-contained; tests/build.test.mjs fails when a copy drifts.
//
// Both hosts also fetch a new copy only when the manifest version changes, so
// the build records a digest of each version's shipped files in RECORD, and
// the test fails when a plugin's files differ from what its version recorded.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RECORD = "scripts/plugin-digests.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";

export const TARGETS = [
  {
    plugin: "codex-review",
    backend: "codex",
    directory: "plugins/codex-review",
    scripts: "plugins/codex-review/skills/codex-review/scripts",
    manifest: "plugins/codex-review/.claude-plugin/plugin.json"
  },
  {
    plugin: "claude-review",
    backend: "claude",
    directory: "plugins/claude-review",
    scripts: "plugins/claude-review/skills/claude-review/scripts",
    manifest: "plugins/claude-review/.codex-plugin/plugin.json"
  }
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

function git(...args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

// What the next commit would ship under the plugin directory: tracked files
// that still exist and untracked files that git does not ignore.
export function pluginFiles(target) {
  const listed = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", target.directory);
  if (listed.status !== 0) {
    throw new Error(`Cannot list the files of ${target.directory}: ${listed.error?.message ?? listed.stderr.trim()}`);
  }
  const files = new Set(listed.stdout.split("\0").filter(Boolean));
  return [...files].filter((file) => fs.existsSync(path.join(ROOT, file)));
}

// Every file an installed copy receives, by path and bytes. The manifest
// counts without its version, which changes with every release. `files` and
// `read` can describe an older commit instead of the working tree.
export function pluginDigest(target, files = pluginFiles(target), read = (file) => fs.readFileSync(path.join(ROOT, file))) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort()) {
    let bytes = read(file);
    if (file === target.manifest) {
      const manifest = JSON.parse(bytes.toString("utf8"));
      delete manifest.version;
      bytes = JSON.stringify(manifest);
    }
    hash.update(`${path.posix.relative(target.directory, file)}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function manifestVersions() {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const versions = TARGETS.map((target) => ({ where: target.manifest, version: read(target.manifest).version }));
  // A marketplace version is optional, but one that is present must agree.
  const marketplace = read(MARKETPLACE);
  if (marketplace.metadata?.version !== undefined) {
    versions.push({ where: `${MARKETPLACE} metadata.version`, version: marketplace.metadata.version });
  }
  for (const plugin of marketplace.plugins ?? []) {
    if (plugin.version !== undefined) versions.push({ where: `${MARKETPLACE} ${plugin.name} version`, version: plugin.version });
  }
  return versions;
}

function readRecord() {
  const file = path.join(ROOT, RECORD);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

// The record as origin/main holds it, or null when origin/main cannot be
// read. Installed copies come from main, so a version listed there may
// already be installed, and the build never records other digests for it.
export function pushedRecord() {
  if (git("rev-parse", "--verify", "--quiet", "origin/main^{commit}").status !== 0) return null;
  const shown = git("show", `origin/main:${RECORD}`);
  return shown.status === 0 ? JSON.parse(shown.stdout) : {};
}

export function currentRelease() {
  return {
    versions: manifestVersions(),
    digests: Object.fromEntries(TARGETS.map((target) => [target.plugin, pluginDigest(target)])),
    record: readRecord()
  };
}

function sharedVersion(versions) {
  const distinct = [...new Set(versions.map((entry) => entry.version))];
  return distinct.length === 1 ? distinct[0] : null;
}

function changedPlugins(recorded, digests) {
  return Object.keys(digests).filter((plugin) => recorded[plugin] !== digests[plugin]);
}

// Returns what keeps the current state from being releasable, as messages
// that say how to fix it; an empty list means every plugin's shipped files
// match the digests recorded for the one version all manifests carry.
export function releaseProblems({ versions, digests, record }) {
  const version = sharedVersion(versions);
  if (!version) {
    return [
      `The manifests disagree on the version (${versions.map((entry) => `${entry.where}: ${entry.version}`).join(", ")}). Set them all to the same version.`
    ];
  }
  const recorded = record[version];
  if (!recorded) return [`Version ${version} has no digests in ${RECORD}. Run \`npm run build\` to record them.`];
  const changed = changedPlugins(recorded, digests);
  if (!changed.length) return [];
  return [
    `The shipped files of ${changed.join(" and ")} differ from what ${RECORD} records for version ${version}. ` +
      `An installed plugin is replaced only when its version changes, so this change would never reach one. ` +
      `Bump the version in ${versions.map((entry) => entry.where).join(", ")}, then run \`npm run build\` to record the new version. ` +
      `If ${version} is not on origin/main yet, \`npm run build\` records the new digests under ${version} instead.`
  ];
}

// Decides what the build records for the current version. `pushed` is the
// record on origin/main, or null when that could not be read.
export function nextRecord({ versions, digests, record }, pushed) {
  const version = sharedVersion(versions);
  if (!version) return { warning: "Digests were not recorded because the manifests disagree on the version." };
  const recorded = record[version];
  if (recorded && !changedPlugins(recorded, digests).length) return {};
  // A branch's record can lack a version that another release has since
  // pushed, so the published digests decide before the local record does.
  const published = pushed?.[version];
  if (published && changedPlugins(published, digests).length) {
    return {
      warning: `${RECORD} does not record these files under ${version}, because origin/main lists other digests for ${version} and installed copies may have it. ` +
        `Bump the version in every manifest and run \`npm run build\` again.`
    };
  }
  if (!recorded) {
    return { record: { ...record, [version]: digests }, recorded: `Recorded the digests of ${version} in ${RECORD}.` };
  }
  if (pushed) {
    return {
      record: { ...record, [version]: digests },
      recorded: published
        ? `Recorded the digests that origin/main lists for ${version} in ${RECORD}.`
        : `Recorded new digests for ${version} in ${RECORD}, since origin/main does not list ${version}.`
    };
  }
  return {
    warning: `${RECORD} keeps the earlier digests of ${version}, because origin/main could not be read to check whether ${version} was pushed. ` +
      `Bump the version in every manifest and run \`npm run build\` again. If ${version} was never pushed, you may instead delete its entry and build again.`
  };
}

export function recordRelease() {
  const next = nextRecord(currentRelease(), pushedRecord());
  if (next.record) fs.writeFileSync(path.join(ROOT, RECORD), `${JSON.stringify(next.record, null, 2)}\n`, "utf8");
  return next;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  for (const copy of build()) process.stdout.write(`${copy.from} -> ${copy.to}\n`);
  const { recorded, warning } = recordRelease();
  if (recorded) process.stdout.write(`${recorded}\n`);
  if (warning) process.stderr.write(`${warning}\n`);
}
