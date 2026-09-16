#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.153.4\n");
  process.exit(0);
}

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();

const valueAfter = (option) => {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : null;
};
const resumed = args[0] === "exec" && args[1] === "resume";
const conversationId = resumed ? args[2] : crypto.randomUUID();
const model = valueAfter("-m") || "codex-default";
const outputPath = valueAfter("-o");
const schemaPath = valueAfter("--output-schema");
const schema = schemaPath && fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null;
const logPath = process.env.FAKE_CODEX_LOG;
if (logPath) {
  fs.appendFileSync(logPath, `${JSON.stringify({
    args,
    input,
    cwd: process.cwd(),
    conversationId,
    model,
    resumed,
    promptFromStdin: args.includes("-"),
    schemaKeys: schema ? Object.keys(schema.properties ?? {}) : null
  })}\n`, "utf8");
}

// Real Codex reports the thread before doing any work, so the runtime can record it early.
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: conversationId })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);

const delay = Number(process.env.FAKE_CODEX_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

if (process.env.FAKE_CODEX_WRITE_FILE) {
  const target = path.join(process.cwd(), process.env.FAKE_CODEX_WRITE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "stray\n", "utf8");
}
if (process.env.FAKE_CODEX_TAG === "1") spawnSync("git", ["tag", "stray-tag"], { cwd: process.cwd() });
if (process.env.FAKE_CODEX_HOOK === "1") {
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: process.cwd(), encoding: "utf8" }).stdout.trim();
  // A unique name with exclusive create: a template-installed hook may be a symlink into the user's dotfiles.
  fs.writeFileSync(path.join(process.cwd(), gitDir, "hooks", "stray-hook"), "#!/bin/sh\nexit 0\n", { encoding: "utf8", flag: "wx" });
}
if (process.env.FAKE_CODEX_COMMIT === "1") {
  spawnSync("git", ["add", "-A"], { cwd: process.cwd() });
  spawnSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "commit", "-qm", "stray commit"], { cwd: process.cwd() });
}

if (process.env.FAKE_CODEX_FAIL === "1") {
  process.stderr.write("simulated Codex failure\n");
  process.exit(2);
}

const structured = {
  verdict: "needs-attention",
  summary: "One material issue found.",
  findings: [
    {
      id: process.env.FAKE_CODEX_REPORT_ID || null,
      observation: process.env.FAKE_CODEX_OBSERVATION || "new",
      severity: "high",
      title: process.env.FAKE_CODEX_TITLE || "Example defect",
      body: "The fake reviewer found a deterministic defect.",
      file: "example.txt",
      line_start: 1,
      line_end: 1,
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
const text = JSON.stringify(structured);
const events = [
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } }
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
if (outputPath) fs.writeFileSync(outputPath, `${text}\n`, "utf8");
