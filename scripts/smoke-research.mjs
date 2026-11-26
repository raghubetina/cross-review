#!/usr/bin/env node

// Opt-in live check of cross-research against the real codex and claude CLIs:
// a research round, check, a shared follow-up, and a brainstorm, on a
// disposable repository, at low effort. Run with `npm run smoke:research`, or
// `npm run smoke:research -- codex` to name the researchers, comma-separated;
// it spends their usage and reads the web. The agy researcher runs only when
// named, with its opt-in set.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "plugins/cross-review/skills/cross-research/scripts/cross-research.mjs");

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", timeout: 30 * 60 * 1000 });
  if (result.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function scratchRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cross-research-smoke-"));
  run("git", ["init", "-q", "-b", "main", "."], repo);
  run("git", ["config", "user.email", "smoke@example.com"], repo);
  run("git", ["config", "user.name", "Smoke"], repo);
  fs.writeFileSync(path.join(repo, "calc.js"), "export function divide(a, b) {\n  return a / b;\n}\n", "utf8");
  run("git", ["add", "calc.js"], repo);
  run("git", ["commit", "-qm", "initial"], repo);
  return repo;
}

function show(output, pattern) {
  process.stdout.write(`${output.split("\n").filter((line) => pattern.test(line)).join("\n")}\n`);
}

const panel = (process.argv[2] ?? "codex,claude").split(",");
const repo = scratchRepo();
const research = (...args) => run(process.execPath, [ENTRY, "--dir", repo, ...args], repo);
// Only the real CLIs show whether Codex's strict --output-schema and Claude's
// --json-schema accept the research and brainstorm schemas, and whether a
// researcher can reach the web from where it runs.
const everySeat = (output, noun) => panel.every((name) => new RegExp(`^== ${name}: completed in .*, [1-9]\\d* ${noun}s? ==$`, "m").test(output));

process.stdout.write(`=== research with ${panel.join(", ")}\n`);
const first = research("research", "--with", panel.join(","), "--effort", "low", "--wait", "--",
  "Which Node.js release added the built-in test runner's --test-shard option, and how is a shard written on the command line? Cite the Node.js documentation or changelog.");
if (!everySeat(first, "claim")) throw new Error(`A seat returned no structured claims:\n${first}`);
show(first, /^(Status|Warning|== |Activity|- .* cited by no other seat|Cited by more)/);

process.stdout.write("=== check\n");
const check = research("check");
if (!/\b[1-9]\d* found\b/.test(check.split("\n")[0])) throw new Error(`No quote was found in its source:\n${check}`);
show(check, /^(Source check|== )/);

process.stdout.write("=== again, shared\n");
const again = research("again", "--share", "--wait", "--", "Confirm or contradict the other researchers' version claim from a source of your own.");
if (!panel.every((name) => new RegExp(`^== ${name}: completed`, "m").test(again)) || !/\(resumed\)/.test(again)) {
  throw new Error(`The follow-up did not resume every seat:\n${again}`);
}
show(again, /^(Status|Shared|Warning|== |  (Supports|Contradicts|Refines|About) )/);

process.stdout.write("=== brainstorm\n");
const ideas = research("brainstorm", "--with", panel.join(","), "--ideas", "3", "--effort", "low", "--wait", "--",
  "What should divide in calc.js do when the divisor is zero?");
if (!everySeat(ideas, "idea")) throw new Error(`A seat returned no structured ideas:\n${ideas}`);
show(ideas, /^(Status|Warning|== |Lens|I-[0-9a-f]{6} |Pool)/);
process.stdout.write(`=== ok (${repo})\n`);
