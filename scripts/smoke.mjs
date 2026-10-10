#!/usr/bin/env node

// Opt-in live check against the real claude and codex CLIs: one review, one
// resumed re-review, cite, and an audit round with a rubric and a checklist,
// on a disposable repository, at low effort. Run with `npm run smoke`, or
// `npm run smoke -- codex` for one half; it spends reviewer usage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = {
  codex: path.join(ROOT, "plugins/codex-review/skills/codex-review/scripts/codex-review.mjs"),
  claude: path.join(ROOT, "plugins/claude-review/skills/claude-review/scripts/claude-review.mjs")
};

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", timeout: 15 * 60 * 1000 });
  if (result.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function scratchRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-smoke-"));
  run("git", ["init", "-q", "-b", "main", "."], repo);
  run("git", ["config", "user.email", "smoke@example.com"], repo);
  run("git", ["config", "user.name", "Smoke"], repo);
  fs.writeFileSync(path.join(repo, "calc.js"), "export function divide(a, b) {\n  return a / b;\n}\n", "utf8");
  run("git", ["add", "calc.js"], repo);
  run("git", ["commit", "-qm", "initial"], repo);
  fs.writeFileSync(path.join(repo, "calc.js"), "export function divide(a, b) {\n  if (b === 0) return Infinity;\n  return a / b;\n}\nexport function average(values) {\n  return values.reduce((sum, v) => sum + v, 0) / values.length;\n}\n", "utf8");
  return repo;
}

const only = process.argv[2];
for (const [name, entry] of Object.entries(ENTRIES)) {
  if (only && only !== name) continue;
  const repo = scratchRepo();
  process.stdout.write(`\n=== ${name}: first review\n`);
  const first = run(process.execPath, [entry, "--dir", repo, "working", "--wait", "--effort", "low"], repo);
  if (!/Status: completed/.test(first) || !/## Verdict/.test(first)) throw new Error(`${name}: first review did not complete:\n${first}`);
  process.stdout.write(`${first.split("\n").filter((line) => /^(Status|Session|Capability|Warning|## Verdict|### )/.test(line)).join("\n")}\n`);
  process.stdout.write(`=== ${name}: again with feedback\n`);
  const again = run(process.execPath, [entry, "--dir", repo, "again", "--wait", "--effort", "low", "--", "Returning Infinity for division by zero is intentional; do not report it again."], repo);
  if (!/Session: resumed/.test(again)) throw new Error(`${name}: again did not resume:\n${again}`);
  process.stdout.write(`${again.split("\n").filter((line) => /^(Status|Session|Warning|## Verdict|### )/.test(line)).join("\n")}\n`);
  process.stdout.write(`=== ${name}: cite\n`);
  process.stdout.write(`${run(process.execPath, [entry, "--dir", repo, "cite"], repo).split("\n").slice(0, 20).join("\n")}\n`);
  // Only the real CLIs show whether Codex's strict --output-schema and Claude's
  // --json-schema accept the schema that a checklist extends.
  process.stdout.write(`=== ${name}: audit with a rubric and a checklist\n`);
  const inputs = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-smoke-audit-"));
  const rubric = path.join(inputs, "rubric.md");
  const checklist = path.join(inputs, "checklist.txt");
  fs.writeFileSync(rubric, "Report a line only when it is not worth keeping: dead, redundant, unreachable, or unidiomatic. Rate one that changes behavior high and any other low.\n", "utf8");
  fs.writeFileSync(checklist, "zero-guard The b === 0 check in divide\nempty-average average when values is empty\n", "utf8");
  const audit = run(process.execPath, [entry, "--dir", repo, "new", "working", "--wait", "--effort", "low", "--rubric-file", rubric, "--checklist-file", checklist], repo);
  // A structured result with at least one verdict shows that the reviewer
  // accepted and filled the extended schema.
  if (!/^## Verdict/m.test(audit) || !/^Coverage: [12] of 2 items have a verdict/m.test(audit)) {
    throw new Error(`${name}: the audit returned no structured result with a verdict:\n${audit}`);
  }
  process.stdout.write(`${audit.split("\n").filter((line) => /^(Status|Coverage|Verdicts|Warning|## Verdict|### |- (zero-guard|empty-average):)/.test(line)).join("\n")}\n`);
  process.stdout.write(`=== ${name}: ok (${repo})\n`);
}
