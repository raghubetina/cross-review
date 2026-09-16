#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

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
const threadId = resumed ? args[2] : crypto.randomUUID();
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
    threadId,
    model,
    resumed,
    promptFromStdin: args.includes("-"),
    schemaKeys: schema ? Object.keys(schema.properties ?? {}) : null
  })}\n`, "utf8");
}

// Real Codex reports the thread before doing any work, so the runtime can record it early.
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);

const delay = Number(process.env.FAKE_CODEX_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

if (process.env.FAKE_CODEX_FAIL === "1") {
  process.stderr.write("simulated Codex failure\n");
  process.exit(2);
}

const structured = {
  verdict: "needs-attention",
  summary: "One material issue found.",
  findings: [
    {
      severity: "high",
      title: "Example defect",
      body: "The fake reviewer found a deterministic defect.",
      file: "example.txt",
      line_start: 1,
      line_end: 1,
      confidence: 0.95,
      recommendation: "Fix the example."
    }
  ],
  residual_risk: "The fake reviewer did not execute tests."
};
const text = JSON.stringify(structured);
const events = [
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } }
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
if (outputPath) fs.writeFileSync(outputPath, `${text}\n`, "utf8");
