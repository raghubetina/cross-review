#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.210 (Claude Code)\n");
  process.exit(0);
}

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();

const valueAfter = (option) => {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : null;
};
const resumed = args.includes("--resume");
const conversationId = valueAfter("--resume") || valueAfter("--session-id") || "missing-session";
const model = valueAfter("--model") || "claude-default";
const schemaJson = valueAfter("--json-schema");
const logPath = process.env.FAKE_CLAUDE_LOG;
if (logPath) {
  fs.appendFileSync(logPath, `${JSON.stringify({
    args,
    input,
    cwd: process.cwd(),
    conversationId,
    model,
    resumed,
    schemaKeys: schemaJson ? Object.keys(JSON.parse(schemaJson).properties ?? {}) : null
  })}\n`, "utf8");
}

const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

if (process.env.FAKE_CLAUDE_WRITE_FILE) {
  const target = path.join(process.cwd(), process.env.FAKE_CLAUDE_WRITE_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "stray\n", "utf8");
}
if (process.env.FAKE_CLAUDE_TAG === "1") spawnSync("git", ["tag", "stray-tag"], { cwd: process.cwd() });
if (process.env.FAKE_CLAUDE_HOOK === "1") {
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: process.cwd(), encoding: "utf8" }).stdout.trim();
  // A unique name with exclusive create: a template-installed hook may be a symlink into the user's dotfiles.
  fs.writeFileSync(path.join(process.cwd(), gitDir, "hooks", "stray-hook"), "#!/bin/sh\nexit 0\n", { encoding: "utf8", flag: "wx" });
}
if (process.env.FAKE_CLAUDE_COMMIT === "1") {
  spawnSync("git", ["add", "-A"], { cwd: process.cwd() });
  spawnSync("git", ["-c", "user.email=fake@example.com", "-c", "user.name=Fake", "commit", "-qm", "stray commit"], { cwd: process.cwd() });
}

if (process.env.FAKE_CLAUDE_FAIL === "1") {
  process.stderr.write("simulated Claude failure\n");
  process.exit(2);
}

const structured = {
  verdict: "needs-attention",
  summary: "One material issue found.",
  findings: [
    {
      id: process.env.FAKE_CLAUDE_REPORT_ID || null,
      observation: process.env.FAKE_CLAUDE_OBSERVATION || "new",
      severity: "high",
      title: process.env.FAKE_CLAUDE_TITLE || "Example defect",
      body: "The fake reviewer found a deterministic defect.",
      file: process.env.FAKE_CLAUDE_FILE || "example.txt",
      line_start: Number(process.env.FAKE_CLAUDE_LINE_START || 1),
      line_end: Number(process.env.FAKE_CLAUDE_LINE_END || process.env.FAKE_CLAUDE_LINE_START || 1),
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

process.stdout.write(`${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: conversationId,
  result: JSON.stringify(structured),
  structured_output: structured,
  modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } }
})}\n`);
