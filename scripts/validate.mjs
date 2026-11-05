#!/usr/bin/env node

// Checks the plugin against each host's own loader: Claude Code's and
// Antigravity's validators, and an install into a throwaway CODEX_HOME, since
// Codex has no validator. Antigravity's validator gains warnings between
// releases and its installer does not validate, so this can start failing with
// no change here. Run with `npm run validate`; every host's CLI must be present.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(binary, args, env = process.env, { quiet = false } = {}) {
  process.stdout.write(`\n=== ${binary} ${args.join(" ")}\n`);
  const result = spawnSync(binary, args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${binary} could not run: ${result.error.message}`);
  if (!quiet) process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${binary} ${args.join(" ")} exited with ${result.status}.`);
  return result.stdout;
}

run("claude", ["plugin", "validate", "--strict", "."]);
run("agy", ["plugin", "validate", "--strict", "plugins/cross-review"]);

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-validate-"));
try {
  const env = { ...process.env, CODEX_HOME: codexHome };
  run("codex", ["plugin", "marketplace", "add", ROOT], env);
  run("codex", ["plugin", "add", "cross-review@cross-review"], env);
  const listed = run("codex", ["debug", "prompt-input"], env, { quiet: true });
  if (!listed.includes("cross-review:cross-review")) throw new Error("Codex installed the plugin but does not list its skill.");
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true });
}
process.stdout.write("\nAll hosts accept the plugin.\n");
