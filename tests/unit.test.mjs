import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import claudeBackend from "../src/backends/claude.mjs";
import codexBackend from "../src/backends/codex.mjs";
import {
  REVIEW_SCHEMA,
  checkCoverage,
  checklistSection,
  consolidateLedger,
  containsSecret,
  coverageWarning,
  likelySecretPath,
  redactSecrets,
  normalizeStructured,
  parseArguments,
  parseChecklist,
  parseDecisions,
  parseReviewerOutput,
  readOptionFile,
  renderStructured,
  resolveChecklistLabel,
  resolveFindingId,
  reviewSchema,
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
    "Looks fine. reject F-1a2b3c: public API; Accept F-2B3C4D; defer F-3c4d5e: next sprint\nreopen F-4d5e6f"
  );
  assert.deepEqual(decisions, [
    { id: "F-1a2b3c", disposition: "rejected", text: "public API" },
    { id: "F-2b3c4d", disposition: "accepted", text: "" },
    { id: "F-3c4d5e", disposition: "deferred", text: "next sprint" },
    { id: "F-4d5e6f", disposition: "open", text: "" }
  ]);
  assert.deepEqual(parseDecisions("no decisions here, just rejecting nothing"), []);
  assert.deepEqual(parseDecisions("should I accept F-1a2b3c? maybe we reject F-2b3c4d later"), []);
  assert.deepEqual(parseDecisions("  accept F-1a2b3c"), [{ id: "F-1a2b3c", disposition: "accepted", text: "" }]);
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
  const decided = {
    findings: {
      "F-000001": { first_job: "review-a", last_job: "review-a", title: "T", file: "a.js", severity: "high", observation: "new", disposition: "rejected", decision: { text: "no", at: "2026-01-01" } },
      "F-000002": { first_job: "review-b", last_job: "review-b", title: "T", file: "a.js", severity: "high", observation: "new", resembles: "F-000001" }
    }
  };
  assert.equal(consolidateLedger(decided), false);
  assert.deepEqual(Object.keys(decided.findings).sort(), ["F-000001", "F-000002"]);
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

test("file options resolve against the current directory and belong to review actions", () => {
  for (const backend of [codexBackend, claudeBackend]) {
    for (const [option, key] of [["--focus-file", "focusFile"], ["--rubric-file", "rubricFile"], ["--checklist-file", "checklistFile"]]) {
      assert.equal(parseArguments([], backend).options[key], null);
      assert.equal(parseArguments([option, "docs/file.md"], backend).options[key], path.resolve("docs/file.md"));
      const again = parseArguments(["again", option, "/elsewhere/file.md", "--", "reject F-1a2b3c: no"], backend);
      assert.equal(again.options[key], "/elsewhere/file.md");
      assert.equal(again.focus, "reject F-1a2b3c: no");
      assert.throws(() => parseArguments([option, "a.md", option, "b.md"], backend), new RegExp(`${option} can be given only once`));
      assert.throws(() => parseArguments([option], backend), new RegExp(`${option} requires a value`));
      for (const action of ["status", "result", "cite", "cancel", "reset"]) {
        assert.throws(() => parseArguments([action, option, "a.md"], backend), new RegExp(`${action} does not accept ${option}`));
      }
    }
    const audit = parseArguments(["repo", "--rubric-file", "r.md", "--checklist-file", "c.txt", "--focus-file", "f.md"], backend);
    assert.deepEqual([audit.options.rubricFile, audit.options.checklistFile, audit.options.focusFile], ["r.md", "c.txt", "f.md"].map((file) => path.resolve(file)));
  }
});

test("readOptionFile returns the text with its SHA-256 and names the option and a file it cannot read", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "focus-file-"));
  const file = path.join(directory, "focus.md");
  const text = "Check claims this change makes false.\n";
  fs.writeFileSync(file, text, "utf8");
  assert.deepEqual(readOptionFile("--focus-file", file), {
    path: file,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
    text
  });
  const missing = path.join(directory, "missing.md");
  assert.throws(() => readOptionFile("--focus-file", missing), { message: `Cannot read --focus-file ${missing}: no such file.` });
  assert.throws(() => readOptionFile("--rubric-file", missing), { message: `Cannot read --rubric-file ${missing}: no such file.` });
  assert.throws(() => readOptionFile("--checklist-file", directory), { message: `Cannot read --checklist-file ${directory}: it is a directory.` });
});

test("parseChecklist reads one id and description per line and names the line it rejects", () => {
  assert.deepEqual(parseChecklist("# shapes\n\nshape:1 A guard clause\r\n  codex:F-1a2b3c   The divisor is unchecked  \n#not-an-item x\n", "c.txt"), [
    { id: "shape:1", description: "A guard clause" },
    { id: "codex:F-1a2b3c", description: "The divisor is unchecked" }
  ]);
  assert.throws(() => parseChecklist("a First\nb Second\na Again\n", "c.txt"), { message: "Invalid --checklist-file c.txt: line 3 repeats item a from line 1." });
  assert.throws(() => parseChecklist("a First\nlonely\n", "c.txt"), { message: "Invalid --checklist-file c.txt: line 2 has an item id but no description." });
  assert.throws(() => parseChecklist("# only a comment\n\n", "c.txt"), { message: "Invalid --checklist-file c.txt: it lists no items." });
});

test("reviewSchema adds verdicts and checklist links only for a checklist, with every property required", () => {
  assert.equal(reviewSchema({}), REVIEW_SCHEMA);
  const schema = reviewSchema({ checklist_file: { items: [{ id: "a", description: "x" }] } });
  assert.notEqual(schema, REVIEW_SCHEMA);
  assert.deepEqual(REVIEW_SCHEMA.required, ["verdict", "summary", "findings", "next_steps", "residual_risk"]);
  assert.equal("checklist_items" in REVIEW_SCHEMA.properties.findings.items.properties, false);
  assert.ok(schema.required.includes("verdicts"));
  assert.ok(schema.properties.findings.items.required.includes("checklist_items"));
  assert.deepEqual(schema.properties.verdicts.items.properties.verdict.enum, ["keep", "finding", "confirm", "refute", "not_applicable"]);
  // Codex's --output-schema is strict: every object requires all of its properties.
  const objects = [schema, schema.properties.findings.items, schema.properties.verdicts.items];
  for (const object of objects) {
    assert.deepEqual([...object.required].sort(), Object.keys(object.properties).sort());
    assert.equal(object.additionalProperties, false);
  }
});

test("checkCoverage maps findings to items after normalization and reports every gap", () => {
  const items = ["a", "b", "c", "d", "e"].map((id) => ({ id, description: `item ${id}` }));
  const base = { observation: "new", body: "b", file: "a.js", pre_existing: false, trigger: "", evidence: "", recommendation: "" };
  const structured = normalizeStructured({
    verdict: "needs-attention",
    summary: "s",
    findings: [
      { ...base, id: null, severity: "low", title: "low", line_start: 1, line_end: 1, confidence: 0.5, checklist_items: ["b"] },
      { ...base, id: null, severity: "high", title: "high", line_start: 2, line_end: 2, confidence: 0.9, checklist_items: ["a", "ghost"] },
      { ...base, id: null, severity: "medium", title: "medium", line_start: 3, line_end: 3, confidence: 0.9, checklist_items: [] }
    ],
    verdicts: [
      { item: "d", verdict: "finding", note: "never linked" },
      { item: "a", verdict: "finding", note: "dead code" },
      { item: "b", verdict: "keep", note: "but a finding links it" },
      { item: "a", verdict: "keep", note: "second answer" },
      { item: "zzz", verdict: "keep", note: "unlisted" }
    ],
    next_steps: [],
    residual_risk: ""
  }, { scope: { kind: "working" } }, {});
  const [high, medium, low] = structured.findings;
  assert.deepEqual([high.title, medium.title, low.title], ["high", "medium", "low"]);
  const coverage = checkCoverage(structured, items);
  assert.deepEqual(coverage.verdicts, [
    { item: "a", description: "item a", verdict: "finding", finding_ids: [high.id], note: "dead code" },
    { item: "b", description: "item b", verdict: "keep", finding_ids: [low.id], note: "but a finding links it" },
    { item: "d", description: "item d", verdict: "finding", finding_ids: [], note: "never linked" }
  ]);
  assert.equal(coverage.items, 5);
  assert.equal(coverage.answered, 3);
  assert.deepEqual(coverage.counts, { keep: 1, finding: 2, confirm: 0, refute: 0, not_applicable: 0 });
  assert.deepEqual(coverage.missing, ["c", "e"]);
  assert.deepEqual(coverage.unknown, ["zzz", "ghost"]);
  assert.deepEqual(coverage.duplicate, ["a"]);
  assert.equal(coverage.normalized, 0);
  assert.deepEqual(coverage.ambiguous, []);
  assert.deepEqual(coverage.unlinked, ["d"]);
  assert.deepEqual(coverage.inconsistent, ["b"]);
  assert.deepEqual(coverage.unknown_verdicts, [{ item: "zzz", verdict: "keep", note: "unlisted" }]);
  assert.equal(
    coverageWarning(coverage),
    "Checklist coverage is incomplete: no verdict for 2 of 5 items (c, e); verdicts or finding links for unknown items (zzz, ghost); " +
      "more than one verdict for (a), so the first was kept; finding verdicts that no finding links to (d); " +
      "findings linked to items marked keep or not_applicable (b)."
  );

  const degraded = checkCoverage(null, items);
  assert.equal(degraded.answered, 0);
  assert.deepEqual(degraded.verdicts, []);
  assert.deepEqual(degraded.missing, ["a", "b", "c", "d", "e"]);
  const complete = checkCoverage({ findings: [], verdicts: items.map((item) => ({ item: item.id, verdict: "keep", note: "" })) }, items);
  assert.equal(coverageWarning(complete), null);
  const many = Array.from({ length: 23 }, (_, index) => ({ id: `i${index}`, description: "x" }));
  assert.match(coverageWarning(checkCoverage(null, many)), /no verdict for 23 of 23 items \(i0, i1, .*, i19, and 3 more\)\.$/);
});

test("checklistSection shows each id in backticks before its description and asks for bare ids", () => {
  assert.equal(checklistSection({}), "");
  const section = checklistSection({
    checklist_file: { path: "c.txt", items: [{ id: "zero-guard", description: "The b === 0 check in divide" }, { id: "codex:F-1a2b3c", description: "The divisor is unchecked" }] }
  });
  assert.ok(section.includes("<review_checklist>\n- `zero-guard` — The b === 0 check in divide\n- `codex:F-1a2b3c` — The divisor is unchecked\n</review_checklist>"));
  assert.ok(section.includes(
    "lists 2 items, each shown below as its id in backticks, an em dash, and its description. Return exactly one entry in verdicts for each item, and no entry for anything else. " +
      "verdicts[].item and findings[].checklist_items[] contain only an id, exactly as it appears between the backticks, never the backticks or the description."
  ));
  assert.doesNotMatch(section, /copied exactly as listed/);
});

test("resolveChecklistLabel prefers an exact id and otherwise reads a copied line as the longest id it starts with", () => {
  const ids = new Set(["zero", "zero-guard", "fix", "fix—guard", "a", "a:"]);
  const resolved = (label) => resolveChecklistLabel(label, ids);
  const exact = (id) => ({ id, normalized: false, ambiguous: false });
  const normalized = (id, ambiguous = false) => ({ id, normalized: true, ambiguous });
  assert.deepEqual(resolved("zero-guard"), exact("zero-guard"));
  assert.deepEqual(resolved("zero"), exact("zero"));
  assert.deepEqual(resolved("a:"), exact("a:"));
  assert.deepEqual(resolved("zero-guard: The b === 0 check in divide"), normalized("zero-guard"));
  assert.deepEqual(resolved("zero-guard : The b === 0 check"), normalized("zero-guard"));
  assert.deepEqual(resolved("zero-guard — The b === 0 check"), normalized("zero-guard"));
  assert.deepEqual(resolved("zero-guard—The b === 0 check"), normalized("zero-guard"));
  assert.deepEqual(resolved("zero-guard - The b === 0 check"), normalized("zero-guard"));
  assert.deepEqual(resolved("zero-guard:"), normalized("zero-guard"));
  assert.deepEqual(resolved("`zero-guard`"), normalized("zero-guard"));
  assert.deepEqual(resolved("`zero-guard` — The b === 0 check"), normalized("zero-guard"));
  assert.deepEqual(resolved("zero: the zero item"), normalized("zero"));
  // Two ids qualify only when the longer one continues past a separator.
  assert.deepEqual(resolved("fix—guard: The guard"), normalized("fix—guard", true));
  assert.deepEqual(resolved("a:: the a-colon item"), normalized("a:"));
  for (const unknown of ["zero-x", "zero-guards", "zero-guard:The", "`zero-guard", "zero-guard`", "- zero-guard: The check", "nothing", "", null]) {
    assert.equal(resolved(unknown), null, String(unknown));
  }
});

test("checkCoverage counts copied labels as normalized, rewrites finding links to ids, and warns only when a label is ambiguous", () => {
  const items = [
    { id: "zero-guard", description: "The b === 0 check in divide" },
    { id: "empty-average", description: "average when values is empty" },
    { id: "fix", description: "The fix" },
    { id: "fix—guard", description: "The guarded fix" }
  ];
  const finding = {
    id: "F-123abc", observation: "new", severity: "high", title: "Remove the zero guard", body: "Redundant.", file: "calc.js",
    line_start: 2, line_end: 2, pre_existing: false, trigger: "", evidence: "", confidence: 0.9, recommendation: "Delete it.",
    checklist_items: ["zero-guard: The b === 0 check in divide", "zero-guard", "ghost: not listed"]
  };
  const structured = {
    verdict: "needs-attention",
    summary: "s",
    findings: [finding],
    verdicts: [
      { item: "zero-guard: The b === 0 check in divide", verdict: "finding", note: "redundant" },
      { item: "`empty-average`", verdict: "keep", note: "NaN is fine" },
      { item: "fix", verdict: "keep", note: "exact" },
      { item: "fix—guard — The guarded fix", verdict: "keep", note: "needed" }
    ],
    next_steps: [],
    residual_risk: ""
  };
  const coverage = checkCoverage(structured, items);
  assert.equal(coverage.normalized, 4);
  assert.deepEqual(coverage.ambiguous, ["fix—guard"]);
  assert.deepEqual(coverage.unknown, ["ghost: not listed"]);
  assert.deepEqual(coverage.duplicate, []);
  assert.deepEqual(coverage.missing, []);
  assert.deepEqual(finding.checklist_items, ["zero-guard", "ghost: not listed"]);
  assert.deepEqual(coverage.verdicts.map((entry) => [entry.item, entry.verdict, entry.finding_ids]), [
    ["zero-guard", "finding", ["F-123abc"]],
    ["empty-average", "keep", []],
    ["fix", "keep", []],
    ["fix—guard", "keep", []]
  ]);
  assert.equal(
    coverageWarning(coverage),
    "Checklist coverage is inconsistent: verdicts or finding links for unknown items (ghost: not listed); labels that match more than one id, read as the longest (fix—guard)."
  );
  const rendered = renderStructured({ ...structured, coverage });
  assert.match(rendered, /Redundant\.\n\nChecklist items: zero-guard, ghost: not listed\n/);
  assert.match(rendered, /## Checklist coverage\n\n4 of 4 items have a verdict \(3 keep, 1 finding\); 4 labels normalized to bare ids\.\n/);

  // Normalization alone is no warning; ambiguity alone is.
  const single = checkCoverage({ findings: [], verdicts: [{ item: "zero-guard: The b === 0 check in divide", verdict: "keep", note: "" }] }, items.slice(0, 1));
  assert.equal(coverageWarning(single), null);
  assert.match(renderStructured({ ...structured, findings: [], coverage: single }), /1 of 1 items have a verdict \(1 keep\); 1 label normalized to a bare id\./);
  const twice = checkCoverage({ findings: [], verdicts: [{ item: "zero-guard", verdict: "keep", note: "" }, { item: "`zero-guard`", verdict: "refute", note: "" }] }, items.slice(0, 1));
  assert.deepEqual(twice.duplicate, ["zero-guard"]);
  assert.equal(twice.verdicts[0].verdict, "keep");
  assert.equal(
    coverageWarning(checkCoverage({ findings: [], verdicts: [{ item: "fix", verdict: "keep", note: "" }, { item: "fix—guard: x", verdict: "keep", note: "" }] }, items.slice(2))),
    "Checklist coverage is ambiguous: labels that match more than one id, read as the longest (fix—guard)."
  );
});

test("renderStructured adds checklist links and a coverage section only when coverage is present", () => {
  const finding = {
    id: "F-123abc", observation: "new", severity: "low", title: "Drop the dead branch", body: "Unreachable.", file: "a.rb",
    line_start: 4, line_end: 4, pre_existing: false, trigger: "", evidence: "", confidence: 0.9, recommendation: "Delete it."
  };
  const plain = { verdict: "needs-attention", summary: "s", findings: [finding], next_steps: [], residual_risk: "r" };
  const before = renderStructured(plain);
  assert.doesNotMatch(before, /Checklist/);
  assert.equal(renderStructured({ ...plain, findings: [{ ...finding, checklist_items: [] }] }), before);
  const items = [{ id: "a", description: "x" }, { id: "b", description: "y" }, { id: "c", description: "z" }];
  const linked = { ...plain, findings: [{ ...finding, checklist_items: ["a"] }], verdicts: [{ item: "a", verdict: "finding", note: "dead\nbranch" }, { item: "b", verdict: "keep", note: "" }] };
  const rendered = renderStructured({ ...linked, coverage: checkCoverage(linked, items) });
  assert.ok(rendered.startsWith(before.slice(0, before.indexOf("Confidence"))));
  assert.match(rendered, /Unreachable\.\n\nChecklist items: a\n/);
  assert.ok(rendered.endsWith(
    "## Residual risk\n\nr\n\n## Checklist coverage\n\n2 of 3 items have a verdict (1 keep, 1 finding); 1 missing.\n\n- a: finding [F-123abc] — dead branch\n- b: keep\n\nNo verdict: c\n"
  ));
});

for (const B of BACKENDS) {
  test(`[${B.name}] skill contract points to its bundled runtime`, () => {
    const skill = fs.readFileSync(path.join(B.skillDirectory, "SKILL.md"), "utf8");
    for (const pattern of B.skillPatterns) assert.match(skill, pattern);
    assert.ok(fs.existsSync(path.join(B.skillDirectory, "scripts", `${B.name}-review.mjs`)));
    assert.ok(fs.existsSync(path.join(B.skillDirectory, "scripts", "runtime.mjs")));
  });
}

