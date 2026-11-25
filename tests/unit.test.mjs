import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import agyBackend from "../plugins/cross-review/skills/cross-review/scripts/backends/agy.mjs";
import claudeBackend from "../plugins/cross-review/skills/cross-review/scripts/backends/claude.mjs";
import codexBackend from "../plugins/cross-review/skills/cross-review/scripts/backends/codex.mjs";
import {
  REVIEW_SCHEMA,
  checkCoverage,
  checklistSection,
  consolidateLedger,
  containsSecret,
  coverageWarning,
  decisionWarning,
  detectHost,
  likelySecretPath,
  nearMiss,
  needsRedaction,
  normalizeStructured,
  parseArguments,
  parseChecklist,
  parseDecisions,
  parseReviewerOutput,
  privateKeyLines,
  readOptionFile,
  redactKeyLines,
  redactSecrets,
  renderStructured,
  sideText,
  resolveChecklistLabel,
  resolveFindingId,
  reviewSchema,
  reviewerEnvironment,
  selectReviewer,
  splitPatches,
  unreadDecisions,
  validateBackend
} from "../plugins/cross-review/skills/cross-review/scripts/runtime.mjs";
import { BACKENDS, ENTRY_SCRIPT } from "./suite.mjs";

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
    "prod.tfvars", "release.jks", "debug.keystore", "vault.kdbx", ".envrc", "config/credentials.yml.enc", "config/master.key",
    "terraform.tfstate", "terraform.tfstate.backup", ".git-credentials", ".pgpass", "id_dsa", "id_ed25519-backup", "github_token", ".token", "deploy.ppk"
  ]) {
    assert.equal(likelySecretPath(file), true, file);
  }
  for (const file of [
    "README.md", "src/token_parser.js", "environment.rb", "keys.js", "secretary.txt", "credentials_form.html",
    "app/models/token.rb", "design/tokens.css", "design/tokens.json", "src/lexer/token.ts", "app/models/secret.rb", "lib/credentials.rb",
    "certs/server.crt"
  ]) {
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
  // Shapes only; none of these is a real credential.
  for (const value of [
    `ASIA${"Q".repeat(16)}`, `gho_${"a".repeat(36)}`, `ghs_${"a".repeat(36)}`, `glpat-${"a".repeat(20)}`, `sk-ant-api03-${"a".repeat(40)}`,
    `sk-proj-${"a".repeat(40)}`, `AIza${"a".repeat(35)}`, `rk_live_${"a".repeat(24)}`, `npm_${"a".repeat(36)}`
  ]) {
    assert.equal(containsSecret(value), true, value);
  }
  const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(30)}.${"c".repeat(40)}`;
  assert.equal(containsSecret(jwt), false);
  assert.equal(needsRedaction(jwt), true);
  assert.equal(needsRedaction("DATABASE_URL=postgres://app:hunter2@db.internal/prod"), true);
  assert.equal(redactSecrets("DATABASE_URL=postgres://app:hunter2@db.internal/prod"), "DATABASE_URL=postgres://app:[redacted]@db.internal/prod");
  assert.equal(needsRedaction("see https://example.com/a and mailto:me@example.com"), false);
  assert.equal(
    redactSecrets("+-----BEGIN RSA PRIVATE KEY-----\n+TUFERS1VUC1C\n+T1JZLU5PVA==\n+-----END RSA PRIVATE KEY-----\n context"),
    "+[redacted]\n+[redacted]\n+[redacted]\n+[redacted]\n context"
  );
  assert.equal(
    redactSecrets("key AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE again\n-----BEGIN RSA PRIVATE KEY-----"),
    "key [redacted] and [redacted] again\n[redacted]"
  );
});

test("privateKeyLines takes a paired key whole, and an unpaired marker's body lines", () => {
  assert.deepEqual([...privateKeyLines("a\n-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----\nb\n")], [2, 3, 4]);
  assert.deepEqual([...privateKeyLines("a\n-----BEGIN PRIVATE KEY-----\nBODY\nmore\n")], [2, 3, 4, 5]);
  assert.deepEqual([...privateKeyLines('k = "-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----"\nafter\n')], [1]);
  assert.deepEqual([...privateKeyLines("nothing here\n")], []);
  assert.deepEqual([...privateKeyLines('head = "-----BEGIN " + "PRIVATE KEY-----"\nBODY\n-----END PRIVATE KEY-----\n')], [3, 2]);
  // A key without an END line stops at the first line that cannot be body.
  assert.deepEqual([...privateKeyLines('x("-----BEGIN PRIVATE KEY-----\\nabc");\nconst y = 1;\n')], [1]);
  assert.deepEqual([...privateKeyLines('  "-----BEGIN PRIVATE KEY-----\\n" +\n  "TUFERS1V\\n" +\n  "-----END PRIVATE KEY-----\\n";\nnext(1);\n')], [1, 2, 3]);
  // A paired key covers its whole span, whatever syntax holds the body.
  assert.deepEqual([...privateKeyLines("-----BEGIN PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nMIIB\nend();\n-----END PRIVATE KEY-----\n")], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...privateKeyLines('KEY = (\n    b"-----BEGIN PRIVATE KEY-----\\n"\n    b"MIIB\\n"\n    b"-----END PRIVATE KEY-----\\n"\n)\n')], [2, 3, 4]);
  assert.deepEqual([...privateKeyLines('x = b"-----BEGIN PRIVATE KEY-----\\n"\n    b"MIIB\\n"\ny = 1\n')], [1, 2]);
});

test("redactKeyLines blanks a key by position, even where the hunk shows no BEGIN line", () => {
  // Made-up body lines, not a key.
  const body = Array.from({ length: 8 }, (_, index) => `Qk9EWS1MSU5FLU5PVC1BLUtFWS${index}`);
  const before = ["test(\"signs\", () => {", "const KEY = `-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----`;", "const other = 1;", "});", ""].join("\n");
  const after = before.replace("const other = 1;", "const other = 2;");
  const ids = { old: "1111111111111111111111111111111111111111", new: "2222222222222222222222222222222222222222" };
  const read = (texts) => (side, file, id) => (file === "keyed.js" && id === ids[side] ? texts[side] : null);
  const tail = [
    "diff --git a/keyed.js b/keyed.js",
    `index ${ids.old}..${ids.new} 100644`,
    "--- a/keyed.js",
    "+++ b/keyed.js",
    "@@ -9,5 +9,5 @@ test(\"signs\", () => {",
    ` ${body[6]}`,
    ` ${body[7]}`,
    " -----END PRIVATE KEY-----`;",
    "-const other = 1;",
    "+const other = 2;",
    " });",
    ""
  ].join("\n");
  assert.equal(redactKeyLines(tail, read({ old: before, new: after })), [
    "diff --git a/keyed.js b/keyed.js",
    `index ${ids.old}..${ids.new} 100644`,
    "--- a/keyed.js",
    "+++ b/keyed.js",
    "@@ -9,5 +9,5 @@ test(\"signs\", () => {",
    " [redacted]",
    " [redacted]",
    " [redacted]",
    "-const other = 1;",
    "+const other = 2;",
    " });",
    ""
  ].join("\n"));

  // Git may name a key line as the enclosing function.
  const named = tail.replace('@@ test("signs", () => {', `@@ ${body[5]}`);
  assert.match(redactKeyLines(named, read({ old: before, new: after })), /^@@ -9,5 \+9,5 @@ \[redacted\]$/m);

  // A removed key is found on the old side, an added one on the new side.
  const removal = [
    "diff --git a/keyed.js b/keyed.js",
    "deleted file mode 100644",
    `index ${ids.old}..${"0".repeat(40)}`,
    "--- a/keyed.js",
    "+++ /dev/null",
    "@@ -1,13 +0,0 @@",
    ...before.split("\n").slice(0, -1).map((line) => `-${line}`),
    ""
  ].join("\n");
  const removed = redactKeyLines(removal, read({ old: before, new: null }));
  assert.equal(removed.split("\n").filter((line) => line === "-[redacted]").length, 10);
  assert.match(removed, /^-const other = 1;$/m);
  assert.doesNotMatch(removed, /Qk9EWS1MSU5F|PRIVATE KEY/);

  // Each line shown must agree with that side's text, carriage returns aside.
  assert.equal(redactKeyLines(tail, read({ old: before.replace(body[7], "SOMETHING-ELSE"), new: after })), null);
  const crlf = (text) => text.replaceAll("\n", "\r\n");
  assert.doesNotMatch(redactKeyLines(tail, read({ old: crlf(before), new: crlf(after) })), /Qk9EWS1MSU5F/);

  // A side that cannot be read, a patch naming no blobs, a combined diff, or a
  // short hunk is refused.
  assert.equal(redactKeyLines(tail, read({ old: null, new: after })), null);
  assert.equal(redactKeyLines(tail.replace(/^index .*\n/m, ""), read({ old: before, new: after })), null);
  assert.equal(redactKeyLines(`diff --cc keyed.js\nindex 1,2..3\n--- a/keyed.js\n+++ b/keyed.js\n@@@ -1,1 -1,1 +1,1 @@@\n  x\n`, read({ old: before, new: after })), null);
  assert.equal(redactKeyLines(tail.replace("@@ -9,5 +9,5 @@", "@@ -9,6 +9,6 @@"), read({ old: before, new: after })), null);
});

test("sideText reads the blob a patch names, and a working file only when it reproduces that blob", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "side-text-"));
  const git = (args, input) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Cross Review Test"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "filter.upper.clean", "tr a-z A-Z"]);
  fs.writeFileSync(path.join(repo, ".gitattributes"), "crlf.txt text eol=crlf\nfiltered.txt filter=upper\n");
  fs.writeFileSync(path.join(repo, "plain.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "crlf.txt"), "one\r\ntwo\r\n");
  fs.writeFileSync(path.join(repo, "filtered.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "files"]);
  const stored = git(["rev-parse", "HEAD:plain.txt"]);
  assert.equal(sideText(repo, stored), "one\ntwo\n");
  assert.equal(sideText(repo, stored, null, 4), null);
  // Working blobs are not stored, so the file must hash to the id Git named:
  // CRLF made LF does, a clean filter's output does not.
  fs.writeFileSync(path.join(repo, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
  fs.writeFileSync(path.join(repo, "filtered.txt"), "one\ntwo\n");
  const crlf = git(["hash-object", "--", "crlf.txt"]);
  assert.equal(sideText(repo, crlf, "crlf.txt"), "one\ntwo\nthree\n");
  assert.equal(sideText(repo, crlf), null);
  assert.equal(sideText(repo, crlf, "crlf.txt", 4), null);
  assert.equal(sideText(repo, git(["hash-object", "--", "filtered.txt"]), "filtered.txt"), null);
  // A filter that answers differently later cannot make other bytes pass.
  assert.equal(sideText(repo, git(["hash-object", "--no-filters", "--stdin"], "other\n"), "plain.txt"), null);
  assert.equal(sideText(repo, "0".repeat(40), "plain.txt"), null);
  assert.equal(sideText(repo, "HEAD", "plain.txt"), null);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("splitPatches reads names Git quotes or follows with a tab", () => {
  const diff = [
    "diff --git a/with space.txt b/with space.txt",
    "--- a/with space.txt\t",
    "+++ b/with space.txt\t",
    "@@ -1 +1 @@",
    "diff --git \"a/tab\\there.txt\" \"b/tab\\there.txt\"",
    "--- \"a/tab\\there.txt\"",
    "+++ \"b/tab\\there.txt\"",
    "@@ -1 +1 @@",
    "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"",
    "new file mode 100644",
    "--- /dev/null",
    "+++ \"b/caf\\303\\251.txt\"",
    ""
  ].join("\n");
  assert.deepEqual(splitPatches(diff).map((chunk) => chunk.file), ["with space.txt", "tab\there.txt", "café.txt"]);
  // Raw, as with core.quotePath=false, inside a name Git quotes for its double quote.
  const emoji = 'diff --git "a/😀 \\"x\\".txt" "b/😀 \\"x\\".txt"\n+++ "b/😀 \\"x\\".txt"\n@@ -1 +1 @@\n';
  assert.deepEqual(splitPatches(emoji).map((chunk) => chunk.file), ['😀 "x".txt']);
  // A changed line holding U+2028 does not start a patch, however it continues.
  const separated = "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n+x\u2028diff --git a/two.txt b/two.txt\n+y\n";
  assert.deepEqual(splitPatches(separated).map((chunk) => chunk.file), ["one.txt"]);
  assert.equal(splitPatches(separated)[0].patch, separated);
  const conflict = "diff --cc both.txt\nindex 1,2..3\n--- a/both.txt\n+++ b/both.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< ours\n";
  assert.deepEqual(splitPatches(conflict).map((chunk) => chunk.file), ["both.txt"]);
  assert.equal(splitPatches(conflict)[0].patch, conflict);
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

test("unreadDecisions names each decision-shaped phrase that parseDecisions skips", () => {
  const cases = {
    "reject F-1a2b3c: it is public. accept F-2b3c4d: agreed": ["accept F-2b3c4d"],
    "reject F-1a2b3c: is it public? accept F-2b3c4d": ["accept F-2b3c4d"],
    "reject F-1a2b3c, accept F-2b3c4d": ["accept F-2b3c4d"],
    "reject F-1a2b3c and accept F-2b3c4d, then defer  F-3c4d5e": ["accept F-2b3c4d", "defer F-3c4d5e"],
    "should I accept F-1a2b3c?": ["accept F-1a2b3c"],
    "reject F-1a2b3c: a reason; accept F-2b3c4d": [],
    "reject F-1a2b3c: a reason\naccept F-2b3c4d": [],
    "reject F-1a2b3c. accept F-2b3c4d": [],
    "Looks fine. REJECT F-1A2B3C: a reason": [],
    "see F-1a2b3c, which I am rejecting": [],
    "": []
  };
  for (const [focus, expected] of Object.entries(cases)) assert.deepEqual(unreadDecisions(focus), expected, focus);
  assert.deepEqual(unreadDecisions(undefined), []);
});

test("decisions read list markers, backticked ids, several ids, and reasons after any separator", () => {
  const read = (focus) => parseDecisions(focus).map(({ id, disposition, text }) => `${id} ${disposition}${text ? ` (${text})` : ""}`);
  assert.deepEqual(read("- reject F-1a2b3c: public API\n* accept F-2b3c4d\n2) defer F-3c4d5e"), [
    "F-1a2b3c rejected (public API)", "F-2b3c4d accepted", "F-3c4d5e deferred"
  ]);
  assert.deepEqual(read("Reject `F-1a2b3c`: public API"), ["F-1a2b3c rejected (public API)"]);
  assert.deepEqual(read("reject F-1a2b3c and F-2b3c4d: both intentional"), ["F-1a2b3c rejected (both intentional)", "F-2b3c4d rejected (both intentional)"]);
  assert.deepEqual(read("reject F-1a2b3c, F-2b3c4d, and F-3c4d5e: all three"), ["F-1a2b3c rejected (all three)", "F-2b3c4d rejected (all three)", "F-3c4d5e rejected (all three)"]);
  assert.deepEqual(read("reject F-1a2b3c because it is public API"), ["F-1a2b3c rejected (because it is public API)"]);
  assert.deepEqual(read("reject F-1a2b3c - it is public API"), ["F-1a2b3c rejected (it is public API)"]);
  assert.deepEqual(read("reject F-1a2b3c. accept F-2b3c4d"), ["F-1a2b3c rejected", "F-2b3c4d accepted"]);
  assert.deepEqual(read("reject F-1a2b3c because this changed in v1.2.3"), ["F-1a2b3c rejected (because this changed in v1.2.3)"]);
  assert.deepEqual(read("reject F-1a2b3c because v1.2 changed it. accept F-2b3c4d"), ["F-1a2b3c rejected (because v1.2 changed it)", "F-2b3c4d accepted"]);
  assert.deepEqual(read("reject F-1a2b3c because it is fine. Accept F- labels as text"), ["F-1a2b3c rejected (because it is fine. Accept F- labels as text)"]);
  assert.deepEqual(unreadDecisions("F-1a2b3c: reject, public API"), ["F-1a2b3c: reject"]);
  assert.deepEqual(unreadDecisions("reject F-1a2b3c: unlike F-2b3c4d - accept it"), []);
  const ledger = { findings: { "F-1a2b3c": {}, "F-2b3c4d": {} }, aliases: {} };
  assert.match(decisionWarning("reject F-1a2b3c: no. Also look at F-2b3c4d and F-9e9e9e.", ledger), /^Mentioned without a decision: F-2b3c4d\. To record one/);
  assert.equal(decisionWarning("reject F-1a2b3c: no", ledger), null);
});

test("a lone near miss of a command or reviewer is refused, and help wins anywhere before --", () => {
  assert.equal(nearMiss("stauts", ["status", "result"]), "status");
  assert.equal(nearMiss("rest", ["reset", "repo"]), "reset");
  assert.equal(nearMiss("status", ["status"]), null);
  assert.equal(nearMiss("tenant", ["status", "reset"]), null);
  assert.throws(() => parseArguments(["stauts"], codexBackend), /Unknown command "stauts"\. Did you mean status\?/);
  assert.equal(parseArguments(["stauts", "of", "the", "importer"], codexBackend).focus, "stauts of the importer");
  assert.throws(() => parseArguments(["reslt", "review-mwpha89z-0451c1"], codexBackend), /Unknown command "reslt"\. Did you mean result\?/);
  assert.throws(() => parseArguments(["ctie", "review-mwpha89z-0451c1"], codexBackend), /Did you mean cite\?/);
  assert.equal(parseArguments(["--", "stauts"], codexBackend).focus, "stauts");
  assert.equal(parseArguments(["repo", "--help"], codexBackend).action, "help");
  assert.equal(parseArguments(["status", "-h"], codexBackend).action, "help");
  assert.equal(parseArguments(["--", "--help"], codexBackend).focus, "--help");
  const reviewers = { codex: { name: "codex" }, claude: { name: "claude" } };
  assert.throws(() => selectReviewer(reviewers, ["codx", "working"], {}), /There is no codx reviewer\. Did you mean codex\?/);
  assert.throws(() => selectReviewer(reviewers, ["cluade"], {}), /Did you mean claude\?/);
  assert.equal(selectReviewer(reviewers, ["status"], { CLAUDECODE: "1" }).reviewer.name, "codex");
});

test("reading decisions takes time in proportion to a large focus", () => {
  const repeated = {
    "phrases it skips": "should I accept F-1a2b3c ",
    "decisions in one reason": "accept F-1a2b3c: a. ",
    "decisions after commas": "accept F-1a2b3c, ",
    "lines ending in commas": "accept F-1a2b3c,\n",
    "clauses": "accept F-1a2b3c; ",
    "spaces": "accept    \t   "
  };
  for (const [name, text] of Object.entries(repeated)) {
    const focus = text.repeat(Math.ceil(2_000_000 / text.length));
    const started = performance.now();
    parseDecisions(focus);
    unreadDecisions(focus);
    // Quadratic parsing would take minutes at this size, so this cannot pass by luck.
    assert.ok(performance.now() - started < 5_000, name);
  }
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
  const structured = { verdict: "approve", summary: "ok", findings: [], next_steps: [], residual_risk: "none" };
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
  const incomplete = parseReviewerOutput({ stdout: events, lastMessage: JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }) }, codexBackend);
  assert.equal(incomplete.structured, null);
  assert.deepEqual(incomplete.schemaErrors, ["result.next_steps is missing", "result.residual_risk is missing"]);
  const wrongSeverity = { ...structured, findings: [{ id: null, observation: "new", severity: "urgent", title: "t", body: "b", file: null, line_start: null, line_end: null, pre_existing: false, trigger: "", evidence: "", confidence: 2, recommendation: "" }] };
  assert.deepEqual(
    parseReviewerOutput({ stdout: events, lastMessage: JSON.stringify(wrongSeverity) }, codexBackend).schemaErrors,
    ["result.findings[0].severity is not one of critical, high, medium, low", "result.findings[0].confidence is above 1"]
  );
  assert.deepEqual(
    parseReviewerOutput({ stdout: events, lastMessage: JSON.stringify({ ...structured, resembles: "F-000000" }) }, codexBackend).schemaErrors,
    ["result.resembles is not in the schema"]
  );
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
    structured_output: { verdict: "approve", summary: "ok", findings: [], next_steps: [], residual_risk: "none" }
  };
  assert.equal(parseReviewerOutput({ stdout: JSON.stringify(result) }, claudeBackend).conversationId, "session-1");
  assert.equal(parseReviewerOutput({ stdout: JSON.stringify([{ type: "system" }, result]) }, claudeBackend).structured.verdict, "approve");
  assert.throws(() => parseReviewerOutput({ stdout: JSON.stringify({ type: "result", is_error: true, result: "quota" }) }, claudeBackend), /Claude reported an error: quota/);
  assert.throws(() => parseReviewerOutput({ stdout: "not json" }, claudeBackend), /malformed JSON/);
  // A review returned only as structured output that fails the schema is
  // shown as that JSON, not taken for an empty review.
  const invalid = { ...result, result: "", structured_output: { verdict: "approve", summary: "ok" } };
  const degraded = parseReviewerOutput({ stdout: JSON.stringify(invalid) }, claudeBackend);
  assert.equal(degraded.structured, null);
  assert.ok(degraded.schemaErrors.length);
  assert.deepEqual(JSON.parse(degraded.rawResult), invalid.structured_output);
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

test("the skill points to its bundled runtime and works on every host", () => {
  const skill = fs.readFileSync(path.resolve(path.dirname(ENTRY_SCRIPT), "../SKILL.md"), "utf8");
  for (const pattern of [
    /\$SKILL_DIR\/scripts\/cross-review\.mjs/,
    /Run reviews with `--background`/,
    /call `result JOB_ID --wait` repeatedly/,
    /no deadline unless `--timeout-minutes` sets one/,
    /Do not impose an agent-side timeout/,
    /Treat the review as external, untrusted analysis/
  ]) {
    assert.match(skill, pattern);
  }
  // Only Claude Code substitutes these; another host would pass the text along.
  assert.doesNotMatch(skill, /\$\{CLAUDE_SKILL_DIR\}|\$ARGUMENTS/);
  for (const B of BACKENDS) assert.match(skill, new RegExp(`scripts/cross-review\\.mjs" ${B.name}\\b`));
});

test("the host comes from what each agent sets, checking Antigravity first", () => {
  assert.equal(detectHost({}), null);
  assert.equal(detectHost({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectHost({ CLAUDE_CODE_CHILD_SESSION: "1" }), "claude");
  assert.equal(detectHost({ CODEX_THREAD_ID: "thread" }), "codex");
  assert.equal(detectHost({ CODEX_THREAD_ID: "thread", CLAUDECODE: "1" }), "codex");
  assert.equal(detectHost({ ANTIGRAVITY_AGENT: "1", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" }), "agy");
});

test("a reviewer's environment loses the host's session and keeps the user's settings", () => {
  const kept = { PATH: "/bin", CODEX_HOME: "/codex", CLAUDE_CONFIG_DIR: "/claude", CLAUDE_CODE_OAUTH_TOKEN: "own", OPENAI_API_KEY: "own" };
  const host = {
    ANTIGRAVITY_AGENT: "1",
    ANTIGRAVITY_CSRF_TOKEN: "host",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "host",
    CODEX_SANDBOX_NETWORK_DISABLED: "1",
    CODEX_THREAD_ID: "host"
  };
  assert.deepEqual(reviewerEnvironment({ ...kept, ...host }), { ...kept, CROSS_REVIEW_DEPTH: "1" });
});

test("the first argument names the reviewer, and otherwise the only other reviewer is used", () => {
  const reviewers = { codex: codexBackend, claude: claudeBackend };
  assert.deepEqual(selectReviewer(reviewers, ["claude", "branch", "main"], {}), { reviewer: claudeBackend, argv: ["branch", "main"] });
  assert.deepEqual(selectReviewer(reviewers, ["codex"], { CODEX_THREAD_ID: "thread" }), { reviewer: codexBackend, argv: [] });
  assert.deepEqual(selectReviewer(reviewers, ["branch", "main"], { CLAUDECODE: "1" }), { reviewer: codexBackend, argv: ["branch", "main"] });
  assert.deepEqual(selectReviewer(reviewers, [], { CODEX_THREAD_ID: "thread" }), { reviewer: claudeBackend, argv: [] });
  // An inherited property is not a reviewer.
  assert.deepEqual(selectReviewer(reviewers, ["constructor"], { CLAUDECODE: "1" }), { reviewer: codexBackend, argv: ["constructor"] });
  for (const env of [{}, { ANTIGRAVITY_AGENT: "1" }]) {
    assert.throws(() => selectReviewer(reviewers, ["working"], env), /Name a reviewer as the first argument: codex or claude/);
  }
  for (const name of ["antigravity", "gemini"]) {
    assert.throws(() => selectReviewer(reviewers, [name], { CLAUDECODE: "1" }), new RegExp(`There is no ${name} reviewer`));
  }
});

test("a reviewer that must be named is never the default", () => {
  const reviewers = { codex: codexBackend, claude: claudeBackend, agy: agyBackend };
  assert.deepEqual(selectReviewer(reviewers, ["agy", "working"], { CLAUDECODE: "1" }), { reviewer: agyBackend, argv: ["working"] });
  assert.deepEqual(selectReviewer(reviewers, ["working"], { CLAUDECODE: "1" }), { reviewer: codexBackend, argv: ["working"] });
  assert.deepEqual(selectReviewer(reviewers, ["working"], { CODEX_THREAD_ID: "thread" }), { reviewer: claudeBackend, argv: ["working"] });
  assert.throws(() => selectReviewer(reviewers, ["working"], { ANTIGRAVITY_AGENT: "1" }), /Name a reviewer as the first argument: codex or claude or agy/);
});

