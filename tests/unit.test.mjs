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
  containsSecret,
  likelySecretPath,
  redactSecrets,
  normalizeStructured,
  parseArguments,
  parseDecisions,
  parseReviewerOutput,
  renderStructured,
  resolveFindingId,
  splitPatches,
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

test("a null-id finding resembles a known one only when it sits near the same lines", () => {
  const job = { scope: { kind: "working" } };
  const session = { ledger: { findings: { "F-aaaaaa": { title: "Unchecked null", file: "a.js", line_start: 10 } } } };
  const base = { id: null, observation: "new", severity: "high", title: "Unchecked null", file: "a.js", body: "b", pre_existing: false, trigger: "", evidence: "", recommendation: "", confidence: 0.9 };
  const near = normalizeStructured({ findings: [{ ...base, line_start: 20, line_end: 20 }] }, job, session).findings[0];
  assert.equal(near.resembles, "F-aaaaaa");
  const far = normalizeStructured({ findings: [{ ...base, line_start: 200, line_end: 200 }] }, job, session).findings[0];
  assert.equal(far.resembles, undefined);
  const unknownLine = normalizeStructured({ findings: [{ ...base, line_start: null, line_end: null }] }, job, session).findings[0];
  assert.equal(unknownLine.resembles, "F-aaaaaa");
});

test("likelySecretPath and containsSecret cover the documented patterns", () => {
  for (const file of [
    ".env", ".env.local", "config/.netrc", ".npmrc", ".pypirc", ".htpasswd", "credentials", "credentials.json", "secrets.yml",
    "token.txt", "id_rsa", "id_ed25519", ".ssh/id_ecdsa.pub", "cert.pem", "server.key", "bundle.p12", "cert.pfx",
    "prod.tfvars", "release.jks", "debug.keystore", "vault.kdbx"
  ]) {
    assert.equal(likelySecretPath(file), true, file);
  }
  for (const file of ["README.md", "src/token_parser.js", "environment.rb", "keys.js", "secretary.txt", "credentials_form.html"]) {
    assert.equal(likelySecretPath(file), false, file);
  }
  assert.equal(containsSecret("-----BEGIN RSA PRIVATE KEY-----\nabc"), true);
  assert.equal(containsSecret("-----BEGIN PRIVATE KEY-----"), true);
  assert.equal(containsSecret("aws_access_key_id = AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(containsSecret("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"), true);
  assert.equal(containsSecret("AKIA is a prefix; -----BEGIN CERTIFICATE----- is fine"), false);
  assert.equal(containsSecret("-----BEGIN PGP PRIVATE KEY BLOCK-----"), true);
  assert.equal(containsSecret("github_pat_11ABCDEFG0123456789abcdefgh"), true);
  assert.equal(containsSecret("sk_live_abcdefghij1234"), true);
  assert.equal(containsSecret("xoxb-1234567890-abcdefghij"), true);
  assert.equal(
    redactSecrets("key AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE again\n-----BEGIN RSA PRIVATE KEY-----"),
    "key [redacted] and [redacted] again\n[redacted]"
  );
});

test("splitPatches keys each patch by its post-image path", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "index 1..2 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    ""
  ].join("\n");
  const chunks = splitPatches(diff);
  assert.deepEqual(chunks.map((chunk) => chunk.file), ["src/a.js", "gone.txt"]);
  assert.match(chunks[0].patch, /^diff --git a\/src\/a\.js/);
  assert.match(chunks[1].patch, /-bye\n$/);
  assert.deepEqual(splitPatches(""), []);
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

test("consolidateLedger folds resembling entries into the earlier id and keeps the old id as an alias", () => {
  const ledger = {
    findings: {
      "F-000001": { first_job: "review-a", last_job: "review-a", title: "Example defect", file: "a.js", severity: "high", observation: "new", disposition: "open", decision: null },
      "F-000002": { first_job: "review-b", last_job: "review-b", title: "Example defect", file: "a.js", severity: "high", observation: "persisting", disposition: "rejected", decision: { text: "later", at: "2026-02-01" }, resembles: "F-000001" },
      "F-000003": { first_job: "review-c", last_job: "review-c", title: "Example defect", file: "a.js", severity: "low", observation: "new" }
    }
  };
  assert.equal(consolidateLedger(ledger), true);
  assert.deepEqual(Object.keys(ledger.findings).sort(), ["F-000001", "F-000003"]);
  assert.deepEqual(ledger.aliases, { "F-000002": "F-000001" });
  assert.equal(ledger.findings["F-000001"].disposition, "rejected");
  assert.equal(ledger.findings["F-000001"].decision.text, "later");
  assert.equal(ledger.findings["F-000001"].observation, "persisting");
  assert.equal(resolveFindingId(ledger, "F-000002"), "F-000001");
  assert.equal(resolveFindingId(ledger, "F-000003"), "F-000003");
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

