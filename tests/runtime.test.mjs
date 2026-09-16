import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import claudeBackend from "../src/backends/claude.mjs";
import codexBackend from "../src/backends/codex.mjs";
import {
  REVIEW_SCHEMA,
  normalizeStructured,
  parseArguments,
  parseReviewerOutput,
  renderStructured,
  resolveRepository,
  resolveScope,
  validateBackend
} from "../src/runtime.mjs";

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));

const BACKENDS = [
  {
    name: "codex",
    label: "Codex",
    module: codexBackend,
    runtime: path.resolve(TEST_ROOT, "../plugins/codex-review/skills/codex-review/scripts/codex-review.mjs"),
    fake: path.resolve(TEST_ROOT, "fixtures/fake-codex.mjs"),
    binEnv: "CODEX_REVIEW_CODEX_BIN",
    logEnv: "FAKE_CODEX_LOG",
    delayEnv: "FAKE_CODEX_DELAY_MS",
    failEnv: "FAKE_CODEX_FAIL",
    writeFileEnv: "FAKE_CODEX_WRITE_FILE",
    commitEnv: "FAKE_CODEX_COMMIT",
    tagEnv: "FAKE_CODEX_TAG",
    hookEnv: "FAKE_CODEX_HOOK",
    artifactDir: "tmp/codex_reviews",
    artifactSegments: ["tmp", "codex_reviews"],
    artifactBasename: "codex_reviews",
    conversationLabel: "Codex thread ID",
    jobIdPattern: /Codex review job: (\S+)/,
    isResume: (args) => args[0] === "exec" && args[1] === "resume",
    assertArgs(args, capability) {
      const sandbox = { full: "danger-full-access", workspace: "workspace-write", "read-only": "read-only" }[capability];
      assert.equal(args[0], "exec");
      assert.ok(args.includes(`sandbox_mode="${sandbox}"`));
      assert.ok(args.includes('approval_policy="never"'));
      assert.ok(args.includes('model_reasoning_effort="max"'));
      assert.ok(args.includes("--json"));
      assert.ok(args.includes("--output-schema"));
      assert.ok(args.includes("--skip-git-repo-check"));
      assert.ok(!args.includes("--ephemeral"));
      assert.ok(!args.includes("-m"));
      assert.equal(args.includes("sandbox_workspace_write.network_access=true"), capability === "workspace");
      assert.ok(!args.some((argument) => argument.startsWith("sandbox_workspace_write.writable_roots=")));
    },
    skillDirectory: path.resolve(TEST_ROOT, "../plugins/codex-review/skills/codex-review"),
    skillPatterns: [
      /\$\{CLAUDE_SKILL_DIR\}\/scripts\/codex-review\.mjs/,
      /Run reviews with `--background`/,
      /call `result --wait` repeatedly/
    ]
  },
  {
    name: "claude",
    label: "Claude",
    module: claudeBackend,
    runtime: path.resolve(TEST_ROOT, "../plugins/claude-review/skills/claude-review/scripts/claude-review.mjs"),
    fake: path.resolve(TEST_ROOT, "fixtures/fake-claude.mjs"),
    binEnv: "CLAUDE_REVIEW_CLAUDE_BIN",
    logEnv: "FAKE_CLAUDE_LOG",
    delayEnv: "FAKE_CLAUDE_DELAY_MS",
    failEnv: "FAKE_CLAUDE_FAIL",
    writeFileEnv: "FAKE_CLAUDE_WRITE_FILE",
    commitEnv: "FAKE_CLAUDE_COMMIT",
    tagEnv: "FAKE_CLAUDE_TAG",
    hookEnv: "FAKE_CLAUDE_HOOK",
    artifactDir: "tmp/claude_reviews",
    artifactSegments: ["tmp", "claude_reviews"],
    artifactBasename: "claude_reviews",
    conversationLabel: "Claude session ID",
    jobIdPattern: /Claude review job: (\S+)/,
    isResume: (args) => args.includes("--resume"),
    assertArgs(args, capability) {
      if (capability === "read-only") {
        assert.ok(args.includes("dontAsk"));
        assert.ok(args.includes("Read,Glob,Grep"));
        assert.ok(!args.includes("bypassPermissions"));
        assert.equal(args[args.indexOf("--setting-sources") + 1], "user");
      } else {
        assert.ok(args.includes("bypassPermissions"));
        assert.ok(!args.includes("--tools"));
        assert.ok(!args.includes("--setting-sources"));
      }
      assert.ok(!args.includes("--strict-mcp-config"));
      assert.equal(args[args.indexOf("--effort") + 1], "max");
      assert.ok(!args.includes("--model"));
    },
    skillDirectory: path.resolve(TEST_ROOT, "../plugins/claude-review/skills/claude-review"),
    skillPatterns: [
      /\$SKILL_DIR\/scripts\/claude-review\.mjs/,
      /Choose foreground or background execution from the workflow/,
      /Do not impose an agent-side timeout/
    ]
  }
];

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 20_000
  });
  if (options.allowFailure !== true && result.status !== 0) {
    throw new Error(`${binary} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function git(repo, ...args) {
  return command("git", ["-C", repo, ...args]).stdout.trim();
}

function calls(logPath) {
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test.before(() => {
  for (const backend of BACKENDS) fs.chmodSync(backend.fake, 0o755);
});

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

function defineSuite(B) {
  const RUNTIME = B.runtime;
  const FAKE = B.fake;

  function createRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `${B.name}-review-test-`));
    command("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Cross Review Test");
    fs.writeFileSync(path.join(repo, "example.txt"), "first\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "initial");
    return repo;
  }

  function reviewEnv(logPath, extra = {}) {
    return {
      ...process.env,
      [B.binEnv]: FAKE,
      [B.logEnv]: logPath,
      ...extra
    };
  }

  function fakeLogPath(repo) {
    return path.join(repo, ...B.artifactSegments, `fake-${B.name}.jsonl`);
  }

  function runReview(repo, args = [], extraEnv = {}) {
    const logPath = fakeLogPath(repo);
    const result = command(process.execPath, [RUNTIME, "--dir", repo, ...args], {
      cwd: repo,
      env: reviewEnv(logPath, extraEnv),
      allowFailure: extraEnv[B.failEnv] === "1" || extraEnv[B.commitEnv] === "1",
      timeout: 30_000
    });
    return { result, logPath };
  }

  function sessions(repo) {
    const root = path.join(repo, ...B.artifactSegments);
    return fs.readdirSync(root)
      .filter((name) => /^\d{3}-/.test(name))
      .sort()
      .map((name) => ({ name, directory: path.join(root, name), session: JSON.parse(fs.readFileSync(path.join(root, name, "session.json"), "utf8")) }));
  }

  function jobs(repo) {
    const directory = path.join(repo, ...B.artifactSegments, "jobs");
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        path: path.join(directory, name),
        job: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))
      }));
  }

  test(`[${B.name}] parseArguments defaults to working at max effort`, () => {
    const parsed = parseArguments([], B.module);
    assert.equal(parsed.action, "working");
    assert.equal(parsed.options.effort, "max");
    assert.equal(parsed.options.model, null);
  });

  test(`[${B.name}] parseArguments preserves natural focus and job IDs`, () => {
    const branch = parseArguments(["branch", "main", "focus", "on", "auth"], B.module);
    assert.equal(branch.scopeArgument, "main");
    assert.equal(branch.focus, "focus on auth");
    const again = parseArguments(["again", "--", "callback", "is", "public"], B.module);
    assert.equal(again.focus, "callback is public");
    const status = parseArguments(["status", "review-123"], B.module);
    assert.equal(status.jobId, "review-123");
    assert.equal(status.focus, "");
    const selected = parseArguments(["--resume-session", "session-1", "range", "HEAD~1..HEAD"], B.module);
    assert.equal(selected.options.resumeSessionId, "session-1");
    assert.equal(selected.action, "range");
  });

  test(`[${B.name}] parseArguments rejects contradictory execution options`, () => {
    assert.throws(() => parseArguments(["--wait", "--background"], B.module), /either --background or --wait/);
    assert.throws(() => parseArguments(["working", "--include-working"], B.module), /not valid/);
    assert.throws(() => parseArguments(["range", "HEAD"], B.module), /form <from>\.\.<to>/);
    assert.throws(() => parseArguments(["--resume-session", "session-1", "new", "working"], B.module), /cannot use/);
    assert.throws(() => parseArguments(["--resume-session", "session-1", "range", "A..B", "--include-working"], B.module), /clean checkout/);
    assert.throws(() => parseArguments(["--resume-session", "session-1"], B.module), /exact committed scope/);
    assert.throws(() => parseArguments(["--resume-session", "session-1", "status"], B.module), /does not accept --resume-session/);
  });



  test(`[${B.name}] resolveScope handles working, branch, commit, range, and repo scopes`, () => {
    const repo = createRepo();
    const first = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(repo, "example.txt"), "second\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "feature change");
    const second = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "local\n", "utf8");

    assert.equal(resolveScope(repo, "working").untracked_files[0], "untracked.txt");
    assert.equal(resolveScope(repo, "branch", "main").merge_base, first);
    assert.equal(resolveScope(repo, "commit", "HEAD").commit, second);
    assert.equal(resolveScope(repo, "range", "main..HEAD").from, first);
    assert.equal(resolveScope(repo, "repo").kind, "repo");
  });

  test(`[${B.name}] working and repo scopes support an unborn branch`, () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `${B.name}-review-unborn-`));
    command("git", ["init", "-b", "main", repo]);
    fs.writeFileSync(path.join(repo, "new.txt"), "uncommitted\n", "utf8");
    assert.equal(resolveScope(repo, "working").head, null);
    assert.equal(resolveScope(repo, "repo").head, null);
    assert.throws(() => resolveScope(repo, "branch", "main"), /requires at least one commit/);
  });

  test(`[${B.name}] foreground review creates ignored artifacts and runs with full capability by default`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n", "utf8");
    const { result, logPath } = runReview(repo, ["working", "--", "focus on correctness"]);

    assert.match(result.stdout, /Status: completed/);
    assert.match(result.stdout, /Example defect/);
    const invocation = calls(logPath)[0];
    assert.equal(invocation.cwd, resolveRepository(repo));
    assert.ok(!B.isResume(invocation.args));
    B.assertArgs(invocation.args, "full");
    assert.ok(invocation.args.includes("--session-id") || invocation.args[0] === "exec");
    assert.match(invocation.input, /scratch work under .*scratch \(it persists across review rounds\)/);
    assert.match(invocation.input, /never commit or push/);
    assert.ok(fs.existsSync(path.join(sessions(repo)[0].directory, "scratch")));
    assert.match(result.stdout, /Capability: full/);
    assert.deepEqual(invocation.schemaKeys, ["verdict", "summary", "findings", "next_steps", "residual_risk"]);
    assert.match(invocation.input, /## What counts as a finding/);
    assert.match(invocation.input, /4\. It was introduced by the change under review/);
    assert.match(invocation.input, /<repository_context>\n[\s\S]*\+changed[\s\S]*<\/repository_context>$/);
    assert.match(invocation.input, /<user_focus>\nfocus on correctness\n<\/user_focus>/);
    assert.doesNotMatch(invocation.input, /Session metadata/);
    assert.match(result.stdout, /### 1\. \[HIGH\] F-[0-9a-f]{6} Example defect — example\.txt:1/);
    assert.match(result.stdout, /## Next steps\n\n1\. Fix the example\./);
    const ledger = sessions(repo)[0].session.ledger.findings;
    const [ledgerId] = Object.keys(ledger);
    assert.match(ledgerId, /^F-[0-9a-f]{6}$/);
    assert.equal(ledger[ledgerId].title, "Example defect");
    assert.equal(ledger[ledgerId].first_job, jobs(repo)[0].job.id);
    assert.equal(ledger[ledgerId].observation, "new");
    assert.match(result.stdout, new RegExp(`${B.conversationLabel}: ${invocation.conversationId}`));
    assert.match(invocation.input, /focus on correctness/);
    assert.match(invocation.input, /-first/);
    assert.match(invocation.input, /\+changed/);

    const task = sessions(repo)[0];
    assert.equal(task.session.review_count, 1);
    assert.equal(task.session.conversation_id, invocation.conversationId);
    const completedJob = jobs(repo)[0].job;
    assert.equal(completedJob.conversation_id, invocation.conversationId);
    assert.ok(completedJob.reviewer_started_at);
    assert.equal(task.session.last_applied_job_id, completedJob.id);
    assert.ok(fs.readdirSync(task.directory).some((name) => /^001-working\.md$/.test(name)));
    assert.equal(git(repo, "check-ignore", `${B.artifactDir}/001-probe`), `${B.artifactDir}/001-probe`);
    assert.doesNotMatch(fs.existsSync(path.join(repo, ".gitignore")) ? fs.readFileSync(path.join(repo, ".gitignore"), "utf8") : "", new RegExp(B.artifactBasename));
  });

  test(`[${B.name}] repo scope asks for pre-existing defects and drops the introduced-only rule`, () => {
    const repo = createRepo();
    const { logPath } = runReview(repo, ["repo"]);
    const input = calls(logPath)[0].input;
    assert.match(input, /pre-existing defects are the point/);
    assert.doesNotMatch(input, /It was introduced by the change under review/);
    assert.doesNotMatch(input, /<user_focus>\n/);
  });

  test(`[${B.name}] again resumes the exact session and forwards feedback`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const first = runReview(repo);
    runReview(repo, ["again", "--", "Do not repeat the callback finding"]);
    const invocations = calls(first.logPath);
    assert.equal(invocations.length, 2);
    assert.ok(B.isResume(invocations[1].args));
    assert.equal(invocations[1].conversationId, invocations[0].conversationId);
    assert.match(invocations[1].input, /Do not repeat the callback finding/);
    assert.equal(sessions(repo)[0].session.review_count, 2);
  });

  test(`[${B.name}] an off-HEAD normal scope retains automatic branch continuity`, () => {
    const repo = createRepo();
    const main = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(repo, "example.txt"), "feature\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "feature candidate");
    const feature = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "main");

    const first = runReview(repo, ["range", `${main}..${feature}`]);
    const sessionId = sessions(repo)[0].session.session_id;
    assert.equal(sessions(repo)[0].session.last_head, main);
    fs.writeFileSync(path.join(repo, "example.txt"), "main follow-up\n", "utf8");
    const second = runReview(repo);

    assert.match(second.result.stdout, new RegExp(`Session ID: ${sessionId}`));
    assert.equal(calls(first.logPath).length, 2);
    assert.equal(sessions(repo)[0].session.review_count, 2);
    assert.equal(sessions(repo)[0].session.active, true);
  });

  test(`[${B.name}] an explicit session resumes across advancing detached HEADs`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--detach", reviewed);

    const first = runReview(repo, ["new", "range", `${base}..${reviewed}`]);
    const sessionId = sessions(repo)[0].session.session_id;
    assert.match(first.result.stdout, new RegExp(`Session ID: ${sessionId}`));

    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed and fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    const second = runReview(repo, [
      "--resume-session",
      sessionId,
      "range",
      `${reviewed}..${fixed}`,
      "--",
      "Verify the bounded fix"
    ]);

    const invocations = calls(first.logPath);
    assert.equal(invocations.length, 2);
    assert.ok(B.isResume(invocations[1].args));
    assert.equal(invocations[1].conversationId, invocations[0].conversationId);
    assert.match(invocations[1].input, /Verify the bounded fix/);
    assert.match(invocations[1].input, new RegExp(`${reviewed}\\.\\.${fixed}`));
    assert.match(second.result.stdout, new RegExp(`Session ID: ${sessionId}`));
    assert.equal(sessions(repo).length, 1);
    assert.equal(sessions(repo)[0].session.review_count, 2);
    assert.equal(sessions(repo)[0].session.last_head, fixed);
    assert.equal(sessions(repo)[0].session.branch, `detached-${fixed.slice(0, 12)}`);
    const third = runReview(repo, ["again", "--", "Confirm the same session remains active"]);
    assert.match(third.result.stdout, new RegExp(`Session ID: ${sessionId}`));
    assert.equal(sessions(repo)[0].session.review_count, 3);
    const jobs = fs.readdirSync(path.join(repo, ...B.artifactSegments, "jobs"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(repo, ...B.artifactSegments, "jobs", name), "utf8")));
    assert.ok(jobs.every((job) => job.session_id === sessionId));
  });

  test(`[${B.name}] an explicit session refuses to shadow an active destination session`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "main review\n", "utf8");
    const first = runReview(repo);
    const mainSessionId = sessions(repo)[0].session.session_id;
    git(repo, "restore", "example.txt");

    git(repo, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(repo, "example.txt"), "feature\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "feature candidate");
    const feature = git(repo, "rev-parse", "HEAD");
    runReview(repo, ["commit", "HEAD"]);
    const featureSessionId = sessions(repo)
      .find(({ session }) => session.branch === "feature").session.session_id;

    git(repo, "checkout", "main");
    git(repo, "merge", "--ff-only", "feature");
    const result = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", featureSessionId, "range", `${base}..${feature}`],
      { cwd: repo, env: reviewEnv(first.logPath), allowFailure: true }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`session ${mainSessionId} is already active for main`));
    assert.equal(calls(first.logPath).length, 2);
    assert.equal(sessions(repo).filter(({ session }) => session.active).length, 2);
    assert.equal(sessions(repo).find(({ session }) => session.session_id === mainSessionId).session.branch, "main");
    assert.equal(sessions(repo).find(({ session }) => session.session_id === featureSessionId).session.branch, "feature");
  });

  test(`[${B.name}] an explicit session rechecks its destination before moving there`, async () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--detach", reviewed);
    const first = runReview(repo, ["new", "range", `${base}..${reviewed}`]);
    const original = sessions(repo)[0];

    fs.writeFileSync(path.join(repo, "example.txt"), "fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    const destination = `detached-${fixed.slice(0, 12)}`;
    const started = command(
      process.execPath,
      [
        RUNTIME,
        "--dir",
        repo,
        "--resume-session",
        original.session.session_id,
        "range",
        `${reviewed}..${fixed}`,
        "--background"
      ],
      {
        cwd: repo,
        env: reviewEnv(first.logPath, { [B.delayEnv]: "1500" })
      }
    );
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);

    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (calls(first.logPath).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls(first.logPath).length, 2);
    const lateDirectory = path.join(repo, ...B.artifactSegments, "999-late-destination");
    fs.mkdirSync(lateDirectory);
    fs.writeFileSync(path.join(lateDirectory, "session.json"), `${JSON.stringify({
      version: 2,
      session_id: "late-destination-session",
      repo_root: repo,
      branch: destination,
      active: true,
      created_at: new Date().toISOString(),
      last_reviewed_at: new Date().toISOString(),
      review_count: 1,
      explicit_model: null,
      last_scope: { kind: "commit", commit: fixed },
      last_head: fixed
    }, null, 2)}\n`, "utf8");

    let status;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = command(process.execPath, [RUNTIME, "status", id, "--dir", repo]).stdout;
      if (status.includes("Status: failed")) break;
    }
    assert.match(status, /Status: failed/);
    assert.match(status, /session late-destination-session is already active/);
    assert.match(status, /new isolated delta session/);
    const after = sessions(repo);
    const originalAfter = after.find(({ session }) => session.session_id === original.session.session_id);
    assert.equal(originalAfter.session.review_count, 1);
    assert.equal(originalAfter.session.branch, `detached-${reviewed.slice(0, 12)}`);
    assert.equal(originalAfter.session.last_head, reviewed);
    assert.equal(originalAfter.session.last_scope.to, reviewed);
    assert.equal(originalAfter.session.active, false);
    assert.equal(originalAfter.session.retired_job_id, id);
    assert.match(originalAfter.session.retired_reason, /new isolated delta session/);
    assert.equal(fs.readdirSync(originalAfter.directory).filter((name) => /^\d{3}-.*\.md$/.test(name)).length, 1);
    assert.equal(after.find(({ session }) => session.session_id === "late-destination-session").session.branch, destination);

    const retry = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", original.session.session_id, "range", `${reviewed}..${fixed}`],
      { cwd: repo, env: reviewEnv(first.logPath), allowFailure: true }
    );
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /was retired.*new isolated delta session/);
    assert.equal(calls(first.logPath).length, 2);
  });

  test(`[${B.name}] an ordinary review can complete while preparation state is locked`, async () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const logPath = fakeLogPath(repo);
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "1500" })
    });
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);

    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (fs.existsSync(logPath) && calls(logPath).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls(logPath).length, 1);
    const lockPath = path.join(repo, ...B.artifactSegments, ".state.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n`, "utf8");

    let status;
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = command(process.execPath, [RUNTIME, "status", id, "--dir", repo]).stdout;
        if (status.includes("Status: completed")) break;
      }
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
    assert.match(status, /Status: completed/);
    assert.equal(sessions(repo)[0].session.review_count, 1);
  });

  test(`[${B.name}] an explicit session refuses replacement history instead of silently starting over`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    runReview(repo);
    const sessionId = sessions(repo)[0].session.session_id;

    git(repo, "checkout", "--orphan", "replacement");
    git(repo, "rm", "-rf", ".");
    fs.writeFileSync(path.join(repo, "replacement.txt"), "replacement\n", "utf8");
    git(repo, "add", "replacement.txt");
    git(repo, "commit", "-m", "replacement history");
    const result = command(process.execPath, [RUNTIME, "--dir", repo, "--resume-session", sessionId, "repo"], {
      cwd: repo,
      env: reviewEnv(path.join(repo, `fake-${B.name}.jsonl`)),
      allowFailure: true
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /last reviewed HEAD is not an ancestor/);
    assert.equal(sessions(repo).length, 1);
    assert.equal(sessions(repo)[0].session.active, true);
    assert.equal(sessions(repo)[0].session.review_count, 1);
  });

  test(`[${B.name}] an explicit session requires its prior HEAD to precede the requested scope`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    runReview(repo, ["range", `${base}..${reviewed}`]);
    const sessionId = sessions(repo)[0].session.session_id;

    fs.writeFileSync(path.join(repo, "example.txt"), "later\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "later candidate");
    const result = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", sessionId, "range", `${base}..${base}`],
      { cwd: repo, env: reviewEnv(path.join(repo, `fake-${B.name}.jsonl`)), allowFailure: true }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /last reviewed HEAD is not an ancestor of the requested scope/);
    assert.equal(sessions(repo)[0].session.review_count, 1);
  });

  test(`[${B.name}] an explicit session rejects legacy off-HEAD review metadata`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    const first = runReview(repo, ["range", `${base}..${reviewed}`]);
    const entry = sessions(repo)[0];

    fs.writeFileSync(path.join(repo, "example.txt"), "ambient\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "unreviewed ambient commit");
    const ambient = git(repo, "rev-parse", "HEAD");
    entry.session.last_head = ambient;
    fs.writeFileSync(path.join(entry.directory, "session.json"), `${JSON.stringify(entry.session, null, 2)}\n`, "utf8");

    fs.writeFileSync(path.join(repo, "example.txt"), "later\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "later candidate");
    const later = git(repo, "rev-parse", "HEAD");
    const result = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", entry.session.session_id, "range", `${ambient}..${later}`],
      { cwd: repo, env: reviewEnv(first.logPath), allowFailure: true }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /do not identify the same recorded commit tip/);
    assert.equal(calls(first.logPath).length, 1);
    assert.equal(sessions(repo)[0].session.review_count, 1);
    assert.equal(sessions(repo)[0].session.last_head, ambient);
  });

  test(`[${B.name}] an explicit committed range refuses uncommitted checkout bytes`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    const first = runReview(repo, ["range", `${base}..${reviewed}`]);
    const session = sessions(repo)[0].session;

    fs.writeFileSync(path.join(repo, "example.txt"), "fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "uncommitted distraction\n", "utf8");
    const result = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", session.session_id, "range", `${reviewed}..${fixed}`],
      { cwd: repo, env: reviewEnv(first.logPath), allowFailure: true }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a clean working tree/);
    assert.equal(calls(first.logPath).length, 1);
    assert.equal(sessions(repo)[0].session.review_count, 1);
    assert.equal(sessions(repo)[0].session.last_head, reviewed);
    const jobs = fs.readdirSync(path.join(repo, ...B.artifactSegments, "jobs"))
      .filter((name) => name.endsWith(".json"));
    assert.equal(jobs.length, 1);
  });

  test(`[${B.name}] unknown and reset sessions fail without invoking the reviewer or creating a task`, () => {
    const unknownRepo = createRepo();
    const unknownLog = path.join(unknownRepo, `fake-${B.name}.jsonl`);
    const unknown = command(
      process.execPath,
      [RUNTIME, "--dir", unknownRepo, "--resume-session", "missing-session", "repo"],
      { cwd: unknownRepo, env: reviewEnv(unknownLog), allowFailure: true }
    );
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, new RegExp(`No ${B.label} review session missing-session exists`));
    assert.equal(fs.existsSync(unknownLog), false);
    assert.equal(sessions(unknownRepo).length, 0);

    const resetRepo = createRepo();
    fs.writeFileSync(path.join(resetRepo, "example.txt"), "changed\n", "utf8");
    const first = runReview(resetRepo);
    const sessionId = sessions(resetRepo)[0].session.session_id;
    runReview(resetRepo, ["reset"]);
    const reset = command(
      process.execPath,
      [RUNTIME, "--dir", resetRepo, "--resume-session", sessionId, "repo"],
      { cwd: resetRepo, env: reviewEnv(first.logPath), allowFailure: true }
    );
    assert.notEqual(reset.status, 0);
    assert.match(reset.stderr, /is inactive/);
    assert.equal(calls(first.logPath).length, 1);
    assert.equal(sessions(resetRepo).length, 1);
  });

  test(`[${B.name}] an explicit session refuses an unrelated unborn checkout`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const first = runReview(repo);
    const sessionId = sessions(repo)[0].session.session_id;

    git(repo, "checkout", "--orphan", "unborn-replacement");
    git(repo, "rm", "-rf", ".");
    fs.writeFileSync(path.join(repo, "replacement.txt"), "replacement\n", "utf8");
    const result = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", sessionId, "repo"],
      { cwd: repo, env: reviewEnv(first.logPath), allowFailure: true }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot resume on an unborn HEAD/);
    assert.equal(calls(first.logPath).length, 1);
    assert.equal(sessions(repo)[0].session.review_count, 1);
  });

  test(`[${B.name}] new creates a fresh session and reset preserves its artifacts`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    runReview(repo);
    runReview(repo, ["new", "working"]);
    const taskEntries = sessions(repo);
    assert.equal(taskEntries.length, 2);
    assert.notEqual(taskEntries[0].session.session_id, taskEntries[1].session.session_id);
    assert.equal(taskEntries.filter(({ session }) => session.active).length, 1);
    const reset = runReview(repo, ["reset"]).result;
    assert.match(reset.stdout, /Reset active/);
    assert.equal(sessions(repo).filter(({ session }) => session.active).length, 0);
  });

  test(`[${B.name}] background review can be observed through status and result`, async () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const logPath = fakeLogPath(repo);
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "150" })
    });
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);

    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = command(process.execPath, [RUNTIME, "status", id, "--dir", repo]).stdout;
      if (status.includes("Status: completed")) break;
    }
    assert.match(status, /Status: completed/);
    const result = command(process.execPath, [RUNTIME, "result", id, "--dir", repo]).stdout;
    assert.match(result, /Example defect/);
  });

  test(`[${B.name}] a moving checkout retires the advanced review without advancing its accepted session`, async () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    const logPath = fakeLogPath(repo);
    runReview(repo, ["range", `${base}..${reviewed}`]);
    const session = sessions(repo)[0].session;

    fs.writeFileSync(path.join(repo, "example.txt"), "fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    const started = command(
      process.execPath,
      [
        RUNTIME,
        "--dir",
        repo,
        "--resume-session",
        session.session_id,
        "range",
        `${reviewed}..${fixed}`,
        "--background"
      ],
      {
        cwd: repo,
        env: reviewEnv(logPath, { [B.delayEnv]: "1500" })
      }
    );
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);

    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (fs.existsSync(logPath) && calls(logPath).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls(logPath).length, 2);
    fs.writeFileSync(path.join(repo, "example.txt"), "moved again\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "move checkout during resumed review");

    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = command(process.execPath, [RUNTIME, "status", id, "--dir", repo]).stdout;
      if (status.includes("Status: failed")) break;
    }
    assert.match(status, /Status: failed/);
    assert.match(status, /Repository HEAD moved during review/);
    assert.match(status, /new isolated delta session/);
    assert.match(status, /Artifact: .*\/failed\//);
    const artifactPath = status.match(/Artifact: (.+)/)?.[1];
    assert.ok(artifactPath);
    assert.match(fs.readFileSync(artifactPath, "utf8"), /Review output \(not applied\)/);
    assert.match(fs.readFileSync(artifactPath, "utf8"), /Example defect/);
    const retired = sessions(repo)[0].session;
    assert.equal(retired.review_count, 1);
    assert.equal(retired.last_head, reviewed);
    assert.equal(retired.last_scope.to, reviewed);
    assert.equal(retired.active, false);
    assert.equal(retired.retired_job_id, id);
    assert.match(retired.retired_reason, /new isolated delta session/);
  });

  test(`[${B.name}] an ordinary resumed failure retires the session without advancing its accepted state`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    runReview(repo);
    const accepted = structuredClone(sessions(repo)[0].session);

    const { result } = runReview(repo, ["again"], { [B.failEnv]: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new isolated delta session/);

    const retired = sessions(repo)[0].session;
    assert.equal(retired.active, false);
    assert.equal(retired.review_count, accepted.review_count);
    assert.deepEqual(retired.last_scope, accepted.last_scope);
    assert.equal(retired.last_head, accepted.last_head);
    assert.ok(retired.retired_job_id);
    assert.match(retired.retired_reason, /new isolated delta session/);
  });

  test(`[${B.name}] a same-SHA named-to-detached checkout change retires an explicit resumed session`, async () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    const first = runReview(repo, ["range", `${base}..${reviewed}`]);
    const accepted = sessions(repo)[0].session;

    fs.writeFileSync(path.join(repo, "example.txt"), "fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    const started = command(
      process.execPath,
      [
        RUNTIME,
        "--dir",
        repo,
        "--resume-session",
        accepted.session_id,
        "range",
        `${reviewed}..${fixed}`,
        "--background"
      ],
      {
        cwd: repo,
        env: reviewEnv(first.logPath, { [B.delayEnv]: "1500" })
      }
    );
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);

    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (calls(first.logPath).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls(first.logPath).length, 2);
    git(repo, "checkout", "--detach", fixed);
    assert.equal(git(repo, "rev-parse", "HEAD"), fixed);

    let status;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = command(process.execPath, [RUNTIME, "status", id, "--dir", repo]).stdout;
      if (status.includes("Status: failed")) break;
    }
    assert.match(status, /Status: failed/);
    assert.match(status, /Repository checkout identity changed during review: expected main, found detached-/);
    assert.match(status, /new isolated delta session/);
    const retired = sessions(repo)[0].session;
    assert.equal(retired.branch, "main");
    assert.equal(retired.review_count, 1);
    assert.equal(retired.last_head, reviewed);
    assert.equal(retired.last_scope.to, reviewed);
    assert.equal(retired.active, false);
    assert.equal(retired.retired_job_id, id);
  });

  test(`[${B.name}] a second review cannot create a stuck job for an active session`, async () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const logPath = path.join(repo, `fake-${B.name}.jsonl`);
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "1000" })
    });
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);
    const duplicate = command(process.execPath, [RUNTIME, "--dir", repo, "working"], {
      cwd: repo,
      env: reviewEnv(logPath),
      allowFailure: true
    });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, new RegExp(`job ${id} is already`));
    const jobs = fs.readdirSync(path.join(repo, ...B.artifactSegments, "jobs")).filter((name) => name.endsWith(".json"));
    assert.equal(jobs.length, 1);
    command(process.execPath, [RUNTIME, "cancel", id, "--dir", repo]);
  });

  test(`[${B.name}] an explicit session reports its in-flight focused review instead of starting another`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    runReview(repo, ["range", `${base}..${reviewed}`]);
    const sessionId = sessions(repo)[0].session.session_id;

    fs.writeFileSync(path.join(repo, "example.txt"), "fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    const logPath = fakeLogPath(repo);
    const started = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", sessionId, "range", `${reviewed}..${fixed}`, "--background"],
      { cwd: repo, env: reviewEnv(logPath, { [B.delayEnv]: "1000" }) }
    );
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);
    const duplicate = command(
      process.execPath,
      [RUNTIME, "--dir", repo, "--resume-session", sessionId, "range", `${reviewed}..${fixed}`],
      { cwd: repo, env: reviewEnv(logPath), allowFailure: true }
    );
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, new RegExp(`job ${id} is already`));
    command(process.execPath, [RUNTIME, "cancel", id, "--dir", repo]);
  });

  test(`[${B.name}] a stale queued job that crashed before recording a PID self-heals`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    runReview(repo);
    const task = sessions(repo)[0];
    const jobsDirectory = path.join(repo, ...B.artifactSegments, "jobs");
    const originalJob = fs.readdirSync(jobsDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(jobsDirectory, name), "utf8")))
      .find((job) => job.status === "completed");
    const stalePath = path.join(jobsDirectory, "review-stale.json");
    fs.writeFileSync(stalePath, `${JSON.stringify({
      version: 2,
      id: "review-stale",
      status: "queued",
      pid: null,
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
      repo_root: originalJob.repo_root,
      task_directory: originalJob.task_directory,
      scope: { kind: "working" }
    })}\n`, "utf8");
    const legacyStatus = command(process.execPath, [RUNTIME, "status", "review-stale", "--dir", repo]).stdout;
    assert.match(legacyStatus, new RegExp(`Session ID: ${task.session.session_id}`));
    runReview(repo, ["again"]);
    const stale = JSON.parse(fs.readFileSync(stalePath, "utf8"));
    assert.equal(stale.status, "failed");
    assert.match(stale.error, /worker exited/);
  });

  test(`[${B.name}] a dead worker after the reviewer starts retires the unapplied session`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const first = runReview(repo);
    const accepted = sessions(repo)[0];
    const acceptedJob = jobs(repo)[0].job;
    const jobsDirectory = path.join(repo, ...B.artifactSegments, "jobs");
    const stalePath = path.join(jobsDirectory, "review-stale-started.json");
    fs.writeFileSync(stalePath, `${JSON.stringify({
      version: 2,
      id: "review-stale-started",
      status: "running",
      pid: 2_147_483_647,
      created_at: "2999-01-01T00:00:00.000Z",
      updated_at: "2999-01-01T00:00:00.000Z",
      reviewer_started_at: "2999-01-01T00:00:01.000Z",
      repo_root: accepted.session.repo_root,
      branch: accepted.session.branch,
      task_directory: acceptedJob.task_directory,
      session_id: accepted.session.session_id,
      scope: { kind: "working" },
      completed_at: "2000-01-01T00:00:00.000Z",
      artifact: path.join(acceptedJob.task_directory, "002-working.md"),
      result_summary: "Unapplied summary",
      rendered_result: "Unapplied result"
    })}\n`, "utf8");

    const again = command(process.execPath, [RUNTIME, "--dir", repo, "again"], {
      cwd: repo,
      env: reviewEnv(first.logPath),
      allowFailure: true
    });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, new RegExp(`previous ${B.label} review session.*retired`, "i"));
    const retired = sessions(repo)[0].session;
    assert.equal(retired.active, false);
    assert.equal(retired.retired_job_id, "review-stale-started");
    const stale = JSON.parse(fs.readFileSync(stalePath, "utf8"));
    assert.equal(stale.status, "failed");
    assert.match(stale.error, /session was retired/);
    assert.equal(stale.artifact, null);
    assert.equal(stale.result_summary, null);
    assert.equal(stale.rendered_result, null);
    assert.match(stale.unapplied_artifact, /002-working\.md$/);
    assert.notEqual(stale.completed_at, "2000-01-01T00:00:00.000Z");

    const replacement = runReview(repo);
    assert.match(replacement.result.stdout, /Notice: Previous session .* was retired/);
    const invocations = calls(first.logPath);
    assert.equal(invocations.length, 2);
    assert.ok(!B.isResume(invocations[1].args));
    assert.notEqual(invocations[1].conversationId, invocations[0].conversationId);
    const taskEntries = sessions(repo);
    assert.equal(taskEntries.length, 2);
    assert.equal(taskEntries[1].session.active, true);
    assert.notEqual(taskEntries[1].session.conversation_id, taskEntries[0].session.conversation_id);
  });

  test(`[${B.name}] an explicit resume refuses a stale session retired during preparation`, () => {
    const repo = createRepo();
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "example.txt"), "reviewed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "reviewed candidate");
    const reviewed = git(repo, "rev-parse", "HEAD");
    const first = runReview(repo, ["range", `${base}..${reviewed}`]);
    const accepted = sessions(repo)[0].session;
    const acceptedJob = jobs(repo)[0].job;

    fs.writeFileSync(path.join(repo, "example.txt"), "fixed\n", "utf8");
    git(repo, "add", "example.txt");
    git(repo, "commit", "-m", "fix review finding");
    const fixed = git(repo, "rev-parse", "HEAD");
    const stalePath = path.join(repo, ...B.artifactSegments, "jobs", "review-stale-explicit.json");
    fs.writeFileSync(stalePath, `${JSON.stringify({
      version: 2,
      id: "review-stale-explicit",
      status: "running",
      pid: 2_147_483_647,
      created_at: "2999-01-01T00:00:00.000Z",
      updated_at: "2999-01-01T00:00:00.000Z",
      reviewer_started_at: "2999-01-01T00:00:01.000Z",
      repo_root: acceptedJob.repo_root,
      branch: accepted.branch,
      task_directory: acceptedJob.task_directory,
      session_id: accepted.session_id,
      scope: { kind: "range", from: reviewed, to: fixed }
    })}\n`, "utf8");

    const resumed = command(
      process.execPath,
      [
        RUNTIME,
        "--dir",
        repo,
        "--resume-session",
        accepted.session_id,
        "range",
        `${reviewed}..${fixed}`
      ],
      { cwd: repo, env: reviewEnv(first.logPath), allowFailure: true }
    );
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, new RegExp(`session ${accepted.session_id} was retired`));
    assert.equal(calls(first.logPath).length, 1);
    const taskEntries = sessions(repo);
    assert.equal(taskEntries.length, 1);
    assert.equal(taskEntries[0].session.active, false);
    assert.equal(taskEntries[0].session.retired_job_id, "review-stale-explicit");
  });

  test(`[${B.name}] a dead worker after applying its result preserves session continuity`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const first = runReview(repo);
    const accepted = sessions(repo)[0].session;
    const completed = jobs(repo).find(({ job }) => job.id === accepted.last_applied_job_id);
    assert.ok(completed);
    completed.job.status = "running";
    completed.job.pid = 2_147_483_647;
    completed.job.reviewer_started_at = "2999-01-01T00:00:01.000Z";
    completed.job.updated_at = "2999-01-01T00:00:01.000Z";
    fs.writeFileSync(completed.path, `${JSON.stringify(completed.job)}\n`, "utf8");

    const resumed = runReview(repo, ["again"]);
    assert.match(resumed.result.stdout, /Session: resumed/);
    assert.doesNotMatch(resumed.result.stdout, /Previous session .* was retired/);
    const invocations = calls(first.logPath);
    assert.equal(invocations.length, 2);
    assert.ok(B.isResume(invocations[1].args));
    assert.equal(invocations[1].conversationId, accepted.conversation_id);
    const current = sessions(repo)[0].session;
    assert.equal(current.active, true);
    assert.equal(current.review_count, 2);
    const recovered = JSON.parse(fs.readFileSync(completed.path, "utf8"));
    assert.equal(recovered.status, "completed");
    assert.match(recovered.recovery_note, /applied-result marker/);
  });

  test(`[${B.name}] legacy jobs recover a session ID only from a matching session inside the current artifact root`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    runReview(repo);
    const canonicalRepo = sessions(repo)[0].session.repo_root;
    const root = path.join(repo, ...B.artifactSegments);
    const jobsDirectory = path.join(root, "jobs");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${B.name}-review-outside-`));
    fs.writeFileSync(path.join(outside, "session.json"), `${JSON.stringify({
      version: 2,
      session_id: "outside-session",
      repo_root: canonicalRepo,
      branch: "main",
      active: true
    })}\n`, "utf8");
    const linkedTask = path.join(root, "999-outside");
    fs.symlinkSync(outside, linkedTask, "dir");
    fs.writeFileSync(path.join(jobsDirectory, "review-legacy-outside.json"), `${JSON.stringify({
      version: 2,
      id: "review-legacy-outside",
      status: "completed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      repo_root: canonicalRepo,
      task_directory: linkedTask,
      scope: { kind: "working" }
    })}\n`, "utf8");

    const status = command(
      process.execPath,
      [RUNTIME, "status", "review-legacy-outside", "--dir", repo]
    ).stdout;
    assert.match(status, /Session ID: unknown/);
    assert.doesNotMatch(status, /outside-session/);

    const canonicalTask = sessions(repo)[0];
    const linkedInsideTask = path.join(root, "996-inside-link");
    fs.symlinkSync(canonicalTask.directory, linkedInsideTask, "dir");
    fs.writeFileSync(path.join(jobsDirectory, "review-legacy-inside-link.json"), `${JSON.stringify({
      version: 2,
      id: "review-legacy-inside-link",
      status: "completed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      repo_root: canonicalRepo,
      task_directory: linkedInsideTask,
      scope: { kind: "working" }
    })}\n`, "utf8");
    const linkedInsideStatus = command(
      process.execPath,
      [RUNTIME, "status", "review-legacy-inside-link", "--dir", repo]
    ).stdout;
    assert.match(linkedInsideStatus, /Session ID: unknown/);
    assert.doesNotMatch(linkedInsideStatus, new RegExp(canonicalTask.session.session_id));

    const insideTask = path.join(root, "998-linked-session");
    fs.mkdirSync(insideTask);
    fs.symlinkSync(path.join(outside, "session.json"), path.join(insideTask, "session.json"));
    fs.writeFileSync(path.join(jobsDirectory, "review-legacy-linked-file.json"), `${JSON.stringify({
      version: 2,
      id: "review-legacy-linked-file",
      status: "completed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      repo_root: canonicalRepo,
      task_directory: insideTask,
      scope: { kind: "working" }
    })}\n`, "utf8");
    const linkedFileStatus = command(
      process.execPath,
      [RUNTIME, "status", "review-legacy-linked-file", "--dir", repo]
    ).stdout;
    assert.match(linkedFileStatus, /Session ID: unknown/);
    assert.doesNotMatch(linkedFileStatus, /outside-session/);

    const mismatchedTask = path.join(root, "997-mismatched-repository");
    fs.mkdirSync(mismatchedTask);
    fs.writeFileSync(path.join(mismatchedTask, "session.json"), `${JSON.stringify({
      version: 2,
      session_id: "mismatched-session",
      repo_root: `${canonicalRepo}-other`,
      branch: "main",
      active: true
    })}\n`, "utf8");
    fs.writeFileSync(path.join(jobsDirectory, "review-legacy-mismatched.json"), `${JSON.stringify({
      version: 2,
      id: "review-legacy-mismatched",
      status: "completed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      repo_root: canonicalRepo,
      task_directory: mismatchedTask,
      scope: { kind: "working" }
    })}\n`, "utf8");
    const mismatchedStatus = command(
      process.execPath,
      [RUNTIME, "status", "review-legacy-mismatched", "--dir", repo]
    ).stdout;
    assert.match(mismatchedStatus, /Session ID: unknown/);
    assert.doesNotMatch(mismatchedStatus, /mismatched-session/);
  });

  test(`[${B.name}] large tracked diffs are truncated instead of failing the review`, { timeout: 30_000 }, () => {
    const repo = createRepo();
    const bigPath = path.join(repo, "big.txt");
    fs.writeFileSync(bigPath, `${"a".repeat(9 * 1024 * 1024)}\n`, "utf8");
    git(repo, "add", "big.txt");
    git(repo, "commit", "-m", "large baseline");
    fs.writeFileSync(bigPath, `${"b".repeat(9 * 1024 * 1024)}\n`, "utf8");
    const { result, logPath } = runReview(repo);
    assert.equal(result.status, 0);
    assert.match(calls(logPath)[0].input, /(Diff|Context) truncated at 8388608 bytes/);
  });

  test(`[${B.name}] cancellation records a consistent cancelled artifact`, async () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const logPath = path.join(repo, `fake-${B.name}.jsonl`);
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "5000" })
    });
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    command(process.execPath, [RUNTIME, "cancel", id, "--dir", repo]);

    let job;
    const jobFile = path.join(repo, ...B.artifactSegments, "jobs", `${id}.json`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      if (job.status === "cancelled" && job.artifact) break;
    }
    assert.equal(job.status, "cancelled");
    assert.match(job.error, /^Cancelled by user\./);
    assert.match(job.error, /session was retired/);
    assert.ok(job.artifact);
    const artifact = fs.readFileSync(job.artifact, "utf8");
    assert.match(artifact, /Status: cancelled/);
    assert.match(artifact, /Cancelled by user/);
    const task = sessions(repo)[0];
    assert.equal(task.session.active, false);
    assert.ok(task.session.retired_at);
    const again = command(process.execPath, [RUNTIME, "--dir", repo, "again"], {
      cwd: repo,
      env: reviewEnv(logPath),
      allowFailure: true
    });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, new RegExp(`previous ${B.label} review session.*retired`, "i"));
  });

  test(`[${B.name}] a newer reset is not misreported as an older retirement`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const failed = runReview(repo, [], { [B.failEnv]: "1" });
    assert.notEqual(failed.result.status, 0);
    const replacement = runReview(repo);
    assert.match(replacement.result.stdout, /Previous session .* was retired/);
    command(process.execPath, [RUNTIME, "--dir", repo, "reset"], { cwd: repo });

    const again = command(process.execPath, [RUNTIME, "--dir", repo, "again"], {
      cwd: repo,
      env: reviewEnv(failed.logPath),
      allowFailure: true
    });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, new RegExp(`No active ${B.label} review session`));
    assert.doesNotMatch(again.stderr, /retired/);

    const afterReset = runReview(repo);
    assert.doesNotMatch(afterReset.result.stdout, /Previous session .* was retired/);
  });

  test(`[${B.name}] again without an active review does not leak an empty task`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const result = command(process.execPath, [RUNTIME, "--dir", repo, "again"], {
      cwd: repo,
      env: reviewEnv(path.join(repo, `fake-${B.name}.jsonl`)),
      allowFailure: true
    });
    assert.notEqual(result.status, 0);
    const root = path.join(repo, ...B.artifactSegments);
    assert.equal(fs.readdirSync(root).filter((name) => /^\d{3}-/.test(name)).length, 0);
  });

  test(`[${B.name}] unrelated replacement history starts a fresh branch session`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    runReview(repo);
    git(repo, "checkout", "--orphan", "replacement");
    git(repo, "rm", "-rf", ".");
    fs.writeFileSync(path.join(repo, "replacement.txt"), "replacement\n", "utf8");
    git(repo, "add", "replacement.txt");
    git(repo, "commit", "-m", "replacement history");
    git(repo, "branch", "-M", "main");
    fs.writeFileSync(path.join(repo, "replacement.txt"), "changed replacement\n", "utf8");
    runReview(repo);
    const taskEntries = sessions(repo);
    assert.equal(taskEntries.length, 2);
    assert.equal(taskEntries[0].session.active, false);
    assert.equal(taskEntries[1].session.active, true);
  });


  test(`[${B.name}] status and result --wait block until a background job ends`, async () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const logPath = fakeLogPath(repo);
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "1200" })
    });
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);
    const waited = command(process.execPath, [RUNTIME, "result", id, "--wait", "--wait-minutes", "1", "--dir", repo], {
      cwd: repo,
      timeout: 30_000
    });
    assert.match(waited.stdout, /Status: completed/);
    assert.match(waited.stdout, /Example defect/);
    assert.doesNotMatch(waited.stdout, /Still running/);
    assert.throws(() => parseArguments(["status", "--wait-minutes", "0"], B.module), /--wait-minutes must be a positive number/);
  });

  test(`[${B.name}] a resumed session without a recorded conversation fails before invoking the reviewer`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const first = runReview(repo);
    const entry = sessions(repo)[0];
    entry.session.conversation_id = null;
    fs.writeFileSync(path.join(entry.directory, "session.json"), `${JSON.stringify(entry.session, null, 2)}\n`, "utf8");
    const again = command(process.execPath, [RUNTIME, "--dir", repo, "again"], {
      cwd: repo,
      env: reviewEnv(first.logPath),
      allowFailure: true
    });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /no recorded conversation to resume/);
    assert.equal(calls(first.logPath).length, 1);
    assert.equal(sessions(repo)[0].session.active, true);
  });

  test(`[${B.name}] the conversation ID is visible while a review is still running`, async () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const logPath = fakeLogPath(repo);
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "2500" })
    });
    const id = started.stdout.match(B.jobIdPattern)?.[1];
    assert.ok(id);
    let status = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = command(process.execPath, [RUNTIME, "status", id, "--dir", repo]).stdout;
      if (/Status: running/.test(status) && new RegExp(`${B.conversationLabel}: [0-9a-f-]{36}`).test(status)) break;
    }
    assert.match(status, /Status: running/);
    assert.match(status, new RegExp(`${B.conversationLabel}: [0-9a-f-]{36}`));
    const finished = command(process.execPath, [RUNTIME, "result", id, "--wait", "--wait-minutes", "1", "--dir", repo], {
      cwd: repo,
      timeout: 30_000
    }).stdout;
    assert.match(finished, /Status: completed/);
    const threadId = calls(logPath)[0].conversationId;
    assert.match(finished, new RegExp(`${B.conversationLabel}: ${threadId}`));

    const again = command(process.execPath, [RUNTIME, "--dir", repo, "again", "--background"], {
      cwd: repo,
      env: reviewEnv(logPath, { [B.delayEnv]: "1500" })
    }).stdout;
    assert.match(again, new RegExp(`${B.conversationLabel}: ${threadId}`));
    const againId = again.match(B.jobIdPattern)?.[1];
    command(process.execPath, [RUNTIME, "result", againId, "--wait", "--wait-minutes", "1", "--dir", repo], { cwd: repo, timeout: 30_000 });
  });

  test(`[${B.name}] state written by an older plugin version is ignored with a notice`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const first = runReview(repo);
    const current = sessions(repo)[0];
    const legacyDirectory = path.join(repo, ...B.artifactSegments, "999-legacy");
    fs.mkdirSync(legacyDirectory);
    fs.writeFileSync(path.join(legacyDirectory, "session.json"), `${JSON.stringify({
      version: 1,
      session_id: "legacy-session",
      repo_root: current.session.repo_root,
      branch: "main",
      active: true,
      created_at: "2999-01-01T00:00:00.000Z",
      review_count: 1,
      last_scope: { kind: "working" },
      last_head: git(repo, "rev-parse", "HEAD")
    })}\n`, "utf8");
    fs.writeFileSync(path.join(repo, ...B.artifactSegments, "jobs", "review-legacy.json"), `${JSON.stringify({
      version: 1,
      id: "review-legacy",
      status: "completed",
      created_at: "2999-01-01T00:00:00.000Z",
      updated_at: "2999-01-01T00:00:00.000Z",
      repo_root: current.session.repo_root,
      task_directory: legacyDirectory,
      scope: { kind: "working" }
    })}\n`, "utf8");

    const status = command(process.execPath, [RUNTIME, "status", "--dir", repo], { cwd: repo });
    assert.doesNotMatch(status.stdout, /review-legacy/);
    assert.match(status.stderr, /Ignoring 1 job written by an older version/);
    const again = runReview(repo, ["again"]);
    assert.match(again.result.stderr, /Ignoring 1 session written by an older version/);
    assert.match(again.result.stdout, new RegExp(`Session ID: ${current.session.session_id}`));
    assert.doesNotMatch(again.result.stdout, /legacy-session/);
    assert.equal(calls(first.logPath).length, 2);
  });

  if (B.name === "claude") {
    test(`[${B.name}] --max-budget-usd reaches the reviewer invocation`, () => {
      const repo = createRepo();
      fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
      const { logPath } = runReview(repo, ["working", "--max-budget-usd", "2.5"]);
      const args = calls(logPath)[0].args;
      assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2.5");
      assert.equal(jobs(repo)[0].job.backend_options.max_budget_usd, 2.5);
    });
  }

  test(`[${B.name}] read-only and workspace capabilities change the invocation and the prompt`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const readOnly = runReview(repo, ["working", "--capability", "read-only"]);
    const first = calls(readOnly.logPath)[0];
    B.assertArgs(first.args, "read-only");
    assert.match(first.input, /Run only read-only Git and diagnostic commands/);
    assert.doesNotMatch(first.input, /scratch work under/);
    assert.equal(fs.existsSync(path.join(sessions(repo)[0].directory, "scratch")), false);
    assert.match(readOnly.result.stdout, /Capability: read-only/);

    const workspace = runReview(repo, ["again", "--capability", "workspace"]);
    const second = calls(workspace.logPath)[1];
    B.assertArgs(second.args, "workspace");
    assert.match(second.input, /scratch work under/);
    assert.match(workspace.result.stdout, /Capability: workspace/);
    const artifact = fs.readFileSync(path.join(sessions(repo)[0].directory, "002-working.md"), "utf8");
    assert.match(artifact, /- Capability: workspace/);
  });

  test(`[${B.name}] a reviewer that dirties the checkout gets a warning, not a failure`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const { result } = runReview(repo, ["working"], { [B.writeFileEnv]: "stray.txt" });
    assert.match(result.stdout, /Status: completed/);
    assert.match(result.stdout, /Warning: The checkout changed during the review: status added: \?\? stray\.txt\./);
    const job = jobs(repo)[0].job;
    assert.match(job.checkout_warning, /stray\.txt/);
    assert.match(fs.readFileSync(job.artifact, "utf8"), /## Warning\n\nThe checkout changed during the review/);
    assert.equal(sessions(repo)[0].session.review_count, 1);
    assert.equal(sessions(repo)[0].session.active, true);
  });

  test(`[${B.name}] checkout changes are reported even when the reviewer fails`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const { result } = runReview(repo, ["working"], { [B.writeFileEnv]: "stray.txt", [B.failEnv]: "1" });
    assert.notEqual(result.status, 0);
    const job = jobs(repo)[0].job;
    assert.equal(job.status, "failed");
    assert.match(job.checkout_warning, /status added: \?\? stray\.txt/);
    const artifact = fs.readFileSync(job.artifact, "utf8");
    assert.match(artifact, /## Warning\n\nThe checkout changed during the review/);
    assert.match(artifact, /## Error/);
    const status = command(process.execPath, [RUNTIME, "status", job.id, "--dir", repo]).stdout;
    assert.match(status, /Warning: The checkout changed during the review/);
  });

  test(`[${B.name}] overwriting an already-dirty file with a non-ASCII name is detected`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "café.txt"), "before\n", "utf8");
    const { result } = runReview(repo, ["working"], { [B.writeFileEnv]: "café.txt" });
    assert.match(result.stdout, /Status: completed/);
    assert.match(result.stdout, /Warning: The checkout changed during the review: content changed: café\.txt\./);
    assert.equal(fs.readFileSync(path.join(repo, "café.txt"), "utf8"), "stray\n");
    assert.equal(sessions(repo)[0].session.last_scope.untracked_files[0], "café.txt");
  });

  test(`[${B.name}] a HEAD move during an ordinary review is reported and the new HEAD recorded`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const before = git(repo, "rev-parse", "HEAD");
    const { result } = runReview(repo, ["working"], { [B.commitEnv]: "1" });
    assert.match(result.stdout, /Status: completed/);
    assert.match(result.stdout, /Warning: HEAD moved during the review \(from /);
    assert.match(result.stdout, /if you did not commit, the reviewer did/);
    const after = git(repo, "rev-parse", "HEAD");
    assert.notEqual(after, before);
    const session = sessions(repo)[0].session;
    assert.equal(session.active, true);
    assert.equal(session.review_count, 1);
    assert.equal(session.last_head, before);
    git(repo, "reset", "-q", "--hard", before);
    fs.writeFileSync(path.join(repo, "example.txt"), "changed again\n", "utf8");
    const continued = runReview(repo, ["again"]);
    assert.match(continued.result.stdout, /Session: resumed/);
    assert.equal(sessions(repo)[0].session.review_count, 2);
  });

  test(`[${B.name}] rewriting a dirty file with identical content is not a change`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "note.txt"), "stray\n", "utf8");
    const { result } = runReview(repo, ["working"], { [B.writeFileEnv]: "note.txt" });
    assert.match(result.stdout, /Status: completed/);
    assert.doesNotMatch(result.stdout, /Warning:/);
  });

  test(`[${B.name}] stray refs, hooks, and newly ignored paths are reported by name`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n", "utf8");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-m", "ignore node_modules");
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const { result } = runReview(repo, ["working"], {
      [B.writeFileEnv]: "node_modules/left-behind.js",
      [B.tagEnv]: "1",
      [B.hookEnv]: "1"
    });
    assert.match(result.stdout, /Status: completed/);
    assert.match(result.stdout, /ignored paths added: node_modules\//);
    assert.match(result.stdout, /refs changed: refs\/tags\/stray-tag/);
    assert.match(result.stdout, /\.git changed: hooks\/stray-hook/);
    assert.doesNotMatch(result.stdout, /status added/);
  });

  test(`[${B.name}] the resume hint appears only once the reviewer has started`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const started = command(process.execPath, [RUNTIME, "--dir", repo, "working", "--background"], {
      cwd: repo,
      env: reviewEnv(fakeLogPath(repo), { [B.delayEnv]: "1500" })
    }).stdout;
    assert.doesNotMatch(started, /Resume interactively/);
    const id = started.match(B.jobIdPattern)?.[1];
    const finished = command(process.execPath, [RUNTIME, "result", id, "--wait", "--wait-minutes", "1", "--dir", repo], { cwd: repo, timeout: 30_000 }).stdout;
    assert.match(finished, /Status: completed/);
    assert.match(finished, /Resume interactively: /);
  });

  test(`[${B.name}] reviewer failures produce a failed artifact and actionable status`, () => {
    const repo = createRepo();
    fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
    const { result } = runReview(repo, [], { [B.failEnv]: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`simulated ${B.label} failure`));
    assert.match(result.stderr, /session was retired/);
    const task = sessions(repo)[0];
    assert.ok(fs.existsSync(path.join(task.directory, "failed")));
    assert.equal(task.session.active, false);
    assert.ok(task.session.retired_at);
  });
}

for (const B of BACKENDS) defineSuite(B);
