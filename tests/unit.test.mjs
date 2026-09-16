import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import claudeBackend from "../src/backends/claude.mjs";
import codexBackend from "../src/backends/codex.mjs";
import {
  REVIEW_SCHEMA,
  consolidateLedger,
  normalizeStructured,
  parseArguments,
  parseDecisions,
  parseReviewerOutput,
  renderStructured,
  validateBackend
} from "../src/runtime.mjs";
import { BACKENDS } from "./suite.mjs";

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));

test("review schema carries no $schema key and requires every v2 field", () => {
  assert.equal("$schema" in REVIEW_SCHEMA, false);
  assert.deepEqual(REVIEW_SCHEMA.required, ["verdict", "summary", "findings", "next_steps", "residual_risk"]);
  const finding = REVIEW_SCHEMA.properties.findings.items;
  assert.deepEqual(finding.required, Object.keys(finding.properties));
  assert.deepEqual(finding.properties.observation.enum, ["new", "persisting", "fixed", "reopen_proposed"]);
});

test("normalizeStructured assigns ids, sorts by severity then confidence, and flags problems", () => {
  const job = { scope: { kind: "working" } };
  const session = { ledger: { findings: { "F-aaaaaa": { title: "known" } } } };
  const base = { body: "b", pre_existing: false, trigger: "", evidence: "", recommendation: "" };
  const structured = normalizeStructured({
    verdict: "needs-attention",
    summary: "s",
    findings: [
      { ...base, id: null, observation: "new", severity: "low", title: "low one", file: "a.js", line_start: 5, line_end: 2, confidence: 0.9 },
      { ...base, id: "F-aaaaaa", observation: "persisting", severity: "high", title: "known", file: "a.js", line_start: 1, line_end: 1, confidence: 0.5 },
      { ...base, id: "F-aaaaaa", observation: "persisting", severity: "high", title: "known again", file: "a.js", line_start: 9, line_end: 9, confidence: 0.4 },
      { ...base, id: "F-zzzzzz", observation: "bogus", severity: "high", title: "invented id", file: null, line_start: null, line_end: null, confidence: 0.99 },
      { ...base, id: null, observation: "new", severity: "critical", title: "worst", file: "b.js", line_start: 3, line_end: 4, confidence: 0.7 }
    ],
    next_steps: [],
    residual_risk: ""
  }, job, session);
  const titles = structured.findings.map((finding) => finding.title);
  assert.deepEqual(titles, ["worst", "invented id", "known", "known again", "low one"]);
  const byTitle = Object.fromEntries(structured.findings.map((finding) => [finding.title, finding]));
  assert.match(byTitle.worst.id, /^F-[0-9a-f]{6}$/);
  assert.notEqual(byTitle["invented id"].id, "F-zzzzzz");
  assert.equal(byTitle["invented id"].observation, "new");
  assert.equal(byTitle["invented id"].location_missing, true);
  assert.equal(byTitle.known.id, "F-aaaaaa");
  assert.equal(byTitle.known.duplicate, false);
  assert.equal(byTitle["known again"].duplicate, true);
  assert.equal(byTitle["low one"].line_end, 5);
  assert.equal(normalizeStructured({ findings: [{ ...base, id: null, severity: "low", title: "t", file: null, line_start: null, confidence: 1 }] }, { scope: { kind: "repo" } }, {}).findings[0].location_missing, false);
});

test("parseDecisions reads verbs, ids, and reasons from focus text", () => {
  const decisions = parseDecisions(
    "Looks fine. reject F-1a2b3c: public API; Accept F-2B3C4D and defer F-3c4d5e: next sprint\nreopen F-4d5e6f"
  );
  assert.deepEqual(decisions, [
    { id: "F-1a2b3c", disposition: "rejected", text: "public API" },
    { id: "F-2b3c4d", disposition: "accepted", text: "" },
    { id: "F-3c4d5e", disposition: "deferred", text: "next sprint" },
    { id: "F-4d5e6f", disposition: "open", text: "" }
  ]);
  assert.deepEqual(parseDecisions("no decisions here, just rejecting nothing"), []);
});

test("consolidateLedger collapses the same file and title into the earliest id and keeps the newest decision", () => {
  const ledger = {
    findings: {
      "F-000002": { first_job: "review-b", last_job: "review-b", title: "Example defect", file: "a.js", severity: "high", observation: "persisting", disposition: "rejected", decision: { text: "later", at: "2026-02-01" } },
      "F-000001": { first_job: "review-a", last_job: "review-a", title: "Example  Defect!", file: "a.js", severity: "high", observation: "new", disposition: "open", decision: null },
      "F-000003": { first_job: "review-c", last_job: "review-c", title: "Other", file: "b.js", severity: "low", observation: "new" }
    }
  };
  assert.equal(consolidateLedger(ledger), true);
  assert.deepEqual(Object.keys(ledger.findings).sort(), ["F-000001", "F-000003"]);
  assert.equal(ledger.findings["F-000001"].disposition, "rejected");
  assert.equal(ledger.findings["F-000001"].decision.text, "later");
  assert.equal(ledger.findings["F-000001"].last_job, "review-b");
  assert.equal(ledger.findings["F-000001"].observation, "persisting");
  assert.equal(consolidateLedger(ledger), false);
});

test("renderStructured shows ids, flags, trigger, evidence, and next steps", () => {
  const rendered = renderStructured({
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [{
      id: "F-123abc", observation: "persisting", severity: "high", title: "Fix it", body: "Because.", file: "a.js",
      line_start: 2, line_end: 3, pre_existing: true, trigger: "Empty input.", evidence: "a.js:2 x = y / 0", confidence: 0.8,
      recommendation: "Guard it.", duplicate: false, location_missing: false
    }],
    next_steps: ["Guard the divisor", "Add a test"],
    residual_risk: "None."
  });
  assert.match(rendered, /### 1\. \[HIGH\] F-123abc Fix it — a\.js:2-3 \(persisting, pre-existing\)/);
  assert.match(rendered, /Trigger: Empty input\./);
  assert.match(rendered, /Evidence:\n\n```\na\.js:2 x = y \/ 0\n```/);
  assert.match(rendered, /## Next steps\n\n1\. Guard the divisor\n2\. Add a test/);
  const fenced = renderStructured({
    verdict: "needs-attention",
    summary: "s",
    findings: [{
      id: "F-abcdef", observation: "new", severity: "low", title: "Quoted fence", body: "b", file: "README.md", line_start: null,
      line_end: null, pre_existing: false, trigger: "", evidence: "README.md:3\n```sh\nnpm test\n```", confidence: 0.5,
      recommendation: "r", duplicate: false, location_missing: true
    }],
    next_steps: [],
    residual_risk: ""
  });
  assert.match(fenced, /Quoted fence — README\.md \(no line cited\)/);
  assert.match(fenced, /Evidence:\n\n````\nREADME\.md:3\n```sh\nnpm test\n```\n````\n/);
});

test("codex backend reads the thread ID, usage, and structured last message from JSONL", () => {
  const structured = { verdict: "approve", summary: "ok", findings: [], residual_risk: "none" };
  const events = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(structured) } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }
  ].map((event) => JSON.stringify(event)).join("\n");
  const parsed = parseReviewerOutput({ stdout: events }, codexBackend);
  assert.equal(parsed.conversationId, "thread-1");
  assert.equal(parsed.structured.verdict, "approve");
  assert.equal(parsed.usage.output_tokens, 3);
  assert.equal(parsed.degraded, false);
  const fromFile = parseReviewerOutput({ stdout: events, lastMessage: `${JSON.stringify({ ...structured, summary: "from file" })}\n` }, codexBackend);
  assert.equal(fromFile.structured.summary, "from file");
  const degraded = parseReviewerOutput({ stdout: events, lastMessage: "plain prose, not JSON\n" }, codexBackend);
  assert.equal(degraded.structured, null);
  assert.equal(degraded.rawResult, "plain prose, not JSON");
  assert.equal(degraded.degraded, true);
  assert.throws(
    () => parseReviewerOutput({ stdout: `${JSON.stringify({ type: "turn.failed", error: { message: "boom" } })}\n` }, codexBackend),
    /Codex reported an error: boom/
  );
  assert.throws(() => parseReviewerOutput({ stdout: "WARNING: not json\n" }, codexBackend), /neither a thread ID nor a final message/);
});

test("claude backend accepts single envelopes and transcript arrays", () => {
  const result = {
    type: "result",
    is_error: false,
    session_id: "session-1",
    structured_output: { verdict: "approve", summary: "ok", findings: [], residual_risk: "none" }
  };
  assert.equal(parseReviewerOutput({ stdout: JSON.stringify(result) }, claudeBackend).conversationId, "session-1");
  assert.equal(parseReviewerOutput({ stdout: JSON.stringify([{ type: "system" }, result]) }, claudeBackend).structured.verdict, "approve");
  assert.throws(() => parseReviewerOutput({ stdout: JSON.stringify({ type: "result", is_error: true, result: "quota" }) }, claudeBackend), /Claude reported an error: quota/);
  assert.throws(() => parseReviewerOutput({ stdout: "not json" }, claudeBackend), /malformed JSON/);
});

test("positional words that match inherited object properties are not options", () => {
  for (const backend of [codexBackend, claudeBackend]) {
    assert.equal(parseArguments(["commit", "constructor"], backend).scopeArgument, "constructor");
    assert.equal(parseArguments(["repo", "focus", "on", "constructor", "behavior"], backend).focus, "focus on constructor behavior");
    assert.equal(parseArguments(["branch", "toString"], backend).scopeArgument, "toString");
  }
});

test("the backend contract is validated at startup", () => {
  assert.equal(validateBackend(codexBackend), codexBackend);
  assert.equal(validateBackend(claudeBackend), claudeBackend);
  assert.throws(() => validateBackend({ ...codexBackend, conversationStrategy: "nope" }), /unknown conversationStrategy/);
  assert.throws(() => validateBackend({ ...claudeBackend, defaultEffort: "ultra" }), /not one of its effort levels/);
  assert.throws(
    () => validateBackend({ ...codexBackend, prompt: { ...codexBackend.prompt, full: { ...codexBackend.prompt.full, tools: "" } } }),
    /prompt\.full\.tools/
  );
  assert.throws(() => validateBackend({ ...claudeBackend, buildArgs: undefined }), /missing: buildArgs/);
});

test("backends own their effort levels and extra options", () => {
  assert.equal(parseArguments(["--effort", "ultra"], codexBackend).options.effort, "ultra");
  assert.throws(() => parseArguments(["--effort", "ultra"], claudeBackend), /Unsupported effort/);
  assert.equal(parseArguments(["--max-budget-usd", "2.5"], claudeBackend).options.backendOptions.max_budget_usd, 2.5);
  assert.throws(() => parseArguments(["--max-budget-usd", "0"], claudeBackend), /must be a positive number/);
  assert.throws(() => parseArguments(["--max-budget-usd", "2"], codexBackend), /Unknown option/);
  assert.equal(parseArguments([], codexBackend).options.capability, "full");
  assert.equal(parseArguments(["--capability", "read-only"], claudeBackend).options.capability, "read-only");
  assert.throws(() => parseArguments(["--capability", "bogus"], codexBackend), /Unsupported capability/);
});

for (const B of BACKENDS) {
  test(`[${B.name}] skill contract points to its bundled runtime`, () => {
    const skill = fs.readFileSync(path.join(B.skillDirectory, "SKILL.md"), "utf8");
    for (const pattern of B.skillPatterns) assert.match(skill, pattern);
    assert.ok(fs.existsSync(path.join(B.skillDirectory, "scripts", `${B.name}-review.mjs`)));
    assert.ok(fs.existsSync(path.join(B.skillDirectory, "scripts", "runtime.mjs")));
  });
}

