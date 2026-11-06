#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.5.1\n");
  process.exit(0);
}
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();

const valueAfter = (option) => {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : null;
};
const resumed = args.includes("--conversation");
const conversationId = process.env.FAKE_AGY_CONVERSATION_ID || valueAfter("--conversation") || crypto.randomUUID();
const model = valueAfter("--model") || "agy-default";
const schemaPath = valueAfter("--json-schema");
const schema = schemaPath && fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null;
const settings = JSON.parse(valueAfter("--settings") ?? "{}");
// `agy` starts outside the repository, so a stray write has to name it, as a real one would.
const repoRoot = settings.permissions?.allow?.[0]?.match(/^read_file\((.*)\)$/)?.[1] ?? process.cwd();
const logPath = process.env.FAKE_AGY_LOG;
if (logPath) {
  fs.appendFileSync(logPath, `${JSON.stringify({
    args,
    input,
    pid: process.pid,
    cwd: process.cwd(),
    conversationId,
    model,
    resumed,
    settings,
    autoUpdateDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
    reviewDepth: process.env.CROSS_REVIEW_DEPTH ?? null,
    hostVariables: Object.keys(process.env).filter((name) => /^(CLAUDECODE|CODEX_THREAD_ID|CODEX_SANDBOX|ANTIGRAVITY_AGENT)/.test(name)),
    schemaKeys: schema ? Object.keys(schema.properties ?? {}) : null
  })}\n`, "utf8");
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Real `agy` reports the conversation before doing any work.
emit({ event: "init", conversation_id: conversationId, init: { model, cwd: process.cwd(), tools: ["read_file"] } });
emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 0, state: "DONE", step_type: "user_input" } });

const delay = Number(process.env.FAKE_AGY_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

if (process.env.FAKE_AGY_WRITE_FILE) {
  const target = path.join(repoRoot, process.env.FAKE_AGY_WRITE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "stray\n", "utf8");
}
if (process.env.FAKE_AGY_TAG === "1") spawnSync("git", ["tag", "stray-tag"], { cwd: repoRoot });
if (process.env.FAKE_AGY_HOOK === "1") {
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  // A unique name with exclusive create: a template-installed hook may be a symlink into the user's dotfiles.
  fs.writeFileSync(path.join(repoRoot, gitDir, "hooks", "stray-hook"), "#!/bin/sh\nexit 0\n", { encoding: "utf8", flag: "wx" });
}
if (process.env.FAKE_AGY_COMMIT === "1") {
  spawnSync("git", ["add", "-A"], { cwd: repoRoot });
  spawnSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "commit", "-qm", "stray commit"], { cwd: repoRoot });
}

if (process.env.FAKE_AGY_FAIL === "1") {
  process.stderr.write("simulated Antigravity failure\n");
  process.exit(2);
}
if (process.env.FAKE_AGY_RESULT === "none") process.exit(0);

const structured = {
  verdict: "needs-attention",
  summary: "One material issue found.",
  findings: [
    {
      id: process.env.FAKE_AGY_REPORT_ID || null,
      observation: process.env.FAKE_AGY_OBSERVATION || "new",
      severity: "high",
      title: process.env.FAKE_AGY_TITLE || "Example defect",
      body: "The fake reviewer found a deterministic defect.",
      file: process.env.FAKE_AGY_FILE || "example.txt",
      line_start: Number(process.env.FAKE_AGY_LINE_START || 1),
      line_end: Number(process.env.FAKE_AGY_LINE_END || process.env.FAKE_AGY_LINE_START || 1),
      pre_existing: false,
      trigger: "Any call.",
      evidence: "example.txt:1 first",
      confidence: 0.95,
      recommendation: "Fix the example."
    }
  ],
  next_steps: ["Fix the example."],
  residual_risk: "The fake reviewer did not execute tests."
};
if (process.env.FAKE_AGY_NO_FINDINGS === "1") {
  structured.verdict = "approve";
  structured.summary = "Nothing material.";
  structured.findings = [];
  structured.next_steps = [];
}
if (process.env.FAKE_AGY_CHECKLIST_ITEMS) {
  for (const finding of structured.findings) finding.checklist_items = process.env.FAKE_AGY_CHECKLIST_ITEMS.split(",");
}
if (process.env.FAKE_AGY_VERDICTS) structured.verdicts = JSON.parse(process.env.FAKE_AGY_VERDICTS);

const result = {
  conversation_id: process.env.FAKE_AGY_RESULT_CONVERSATION_ID || conversationId,
  status: "SUCCESS",
  response: `${JSON.stringify(structured)}\n`,
  duration_seconds: 1.5,
  num_turns: 1,
  structured_output: structured,
  usage: { input_tokens: 100, output_tokens: 30, thinking_tokens: 5, cache_read_tokens: 20, total_tokens: 130 }
};
// The shapes `agy` was seen to end with when a turn produced no usable review.
if (process.env.FAKE_AGY_RESULT === "denied") {
  result.response = "";
  delete result.structured_output;
  result.denied_actions = [{ tool: "run_command", input: "npm test" }];
}
if (process.env.FAKE_AGY_RESULT === "no-structured") delete result.structured_output;
if (process.env.FAKE_AGY_RESULT === "error") result.status = "ERROR";
emit({ event: "result", result });
if (process.env.FAKE_AGY_RESULT_MARKER) fs.writeFileSync(process.env.FAKE_AGY_RESULT_MARKER, "printed\n", "utf8");

// Reports say the real process can stay alive after printing its result.
if (process.env.FAKE_AGY_HANG === "holder") spawn("sleep", ["20"], { detached: true, stdio: "inherit" }).unref();
if (process.env.FAKE_AGY_HANG) await new Promise((resolve) => setTimeout(resolve, 60_000));
