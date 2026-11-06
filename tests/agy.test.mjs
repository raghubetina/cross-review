import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArguments, resolveRepository, validateBackend } from "../plugins/cross-review/skills/cross-review/scripts/runtime.mjs";
import { BACKENDS, calls, command, defineSuite, git } from "./suite.mjs";

const B = BACKENDS.find((backend) => backend.name === "agy");
const ENTRY = [path.resolve(path.dirname(B.fake), "../../plugins/cross-review/skills/cross-review/scripts/cross-review.mjs"), "agy"];
const SHORT_GRACE = pathToFileURL(fileURLToPath(new URL("fixtures/short-result-grace.mjs", import.meta.url))).href;
const ARTIFACTS = "tmp/agy_reviews";

test.before(() => fs.chmodSync(B.fake, 0o755));
defineSuite(B);

function changedRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-backend-test-"));
  command("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Cross Review Test");
  fs.writeFileSync(path.join(repo, "example.txt"), "first\n", "utf8");
  git(repo, "add", "example.txt");
  git(repo, "commit", "-m", "initial");
  fs.writeFileSync(path.join(repo, "example.txt"), "changed\n", "utf8");
  return repo;
}

function logPath(repo) {
  return path.join(repo, ...ARTIFACTS.split("/"), "fake-agy.jsonl");
}

function review(repo, args = ["working"], extra = {}, nodeOptions = []) {
  const env = { ...process.env, ...B.env, [B.binEnv]: B.fake, [B.logEnv]: logPath(repo), ...extra };
  return command(process.execPath, [...nodeOptions, ...ENTRY, "--dir", repo, ...args], { cwd: repo, env, allowFailure: true });
}

test("[agy] it stays off until the user opts in, before anything is recorded", () => {
  for (const value of [undefined, "", "yes", "api-key"]) {
    const repo = changedRepo();
    const refused = review(repo, ["working"], { CROSS_REVIEW_AGY_AUTH: value ?? "" });
    assert.notEqual(refused.status, 0, String(value));
    assert.match(refused.stderr, /off until you opt in.*Google's FAQ and terms conflict.*CROSS_REVIEW_AGY_AUTH=login/);
    assert.equal(fs.existsSync(path.join(repo, "tmp")), false);
  }
});

test("[agy] the internal entry refuses without the opt-in too", () => {
  const repo = changedRepo();
  assert.notEqual(review(repo, ["working"], { FAKE_AGY_FAIL: "1" }).status, 0);
  const jobs = path.join(repo, ...ARTIFACTS.split("/"), "jobs");
  const id = fs.readdirSync(jobs).find((name) => name.endsWith(".json")).replace(/\.json$/, "");
  const env = { ...process.env, [B.binEnv]: B.fake, [B.logEnv]: logPath(repo), CROSS_REVIEW_AGY_AUTH: "" };
  const retried = command(process.execPath, [...ENTRY, "__run-job", id, "--dir", repo], { cwd: repo, env, allowFailure: true });
  assert.notEqual(retried.status, 0);
  assert.match(retried.stderr, /off until you opt in/);
  assert.equal(calls(logPath(repo)).length, 1);
});

test("[agy] it refuses a temporary directory inside any repository, even through a link", () => {
  const repo = changedRepo();
  const other = changedRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-backend-outside-"));
  fs.mkdirSync(path.join(repo, "local-tmp"));
  fs.mkdirSync(path.join(other, "nested", "tmp"), { recursive: true });
  fs.symlinkSync(path.join(repo, "local-tmp"), path.join(outside, "link"));
  for (const tmpdir of [path.join(repo, "local-tmp"), path.join(other, "nested", "tmp"), path.join(outside, "link")]) {
    const refused = review(repo, ["working"], { TMPDIR: tmpdir });
    assert.notEqual(refused.status, 0, tmpdir);
    assert.match(refused.stderr, /is inside the Git repository .*Point TMPDIR outside any repository/);
    assert.deepEqual(fs.readdirSync(tmpdir), []);
    assert.equal(fs.existsSync(path.join(repo, "tmp")), false);
  }
});

test("[agy] job controls need no opt-in, so an earlier result stays readable", () => {
  const repo = changedRepo();
  assert.equal(review(repo).status, 0);
  for (const action of ["status", "result", "cite"]) {
    assert.equal(review(repo, [action], { CROSS_REVIEW_AGY_AUTH: "" }).status, 0, action);
  }
});

test("[agy] it is read-only, with effort levels that its models have", () => {
  validateBackend(B.module);
  assert.equal(parseArguments([], B.module).options.capability, "read-only");
  assert.equal(parseArguments([], B.module).options.effort, "medium");
  for (const capability of ["full", "workspace"]) {
    assert.throws(() => parseArguments(["--capability", capability], B.module), /Unsupported capability .* Use read-only\./);
  }
  for (const effort of ["max", "xhigh"]) {
    assert.throws(() => parseArguments(["--effort", effort], B.module), /Unsupported effort/);
  }
});

test("[agy] it starts in an empty directory outside the repository and leaves nothing behind", () => {
  const repo = changedRepo();
  fs.mkdirSync(path.join(repo, ".agents"));
  assert.equal(review(repo).status, 0);
  const [invocation] = calls(logPath(repo));
  const root = resolveRepository(repo);
  assert.ok(!path.relative(root, invocation.cwd).match(/^[^.]/), `${invocation.cwd} is inside ${root}`);
  assert.equal(path.dirname(invocation.cwd), fs.realpathSync(os.tmpdir()));
  assert.equal(fs.existsSync(invocation.cwd), false);
  assert.equal(invocation.autoUpdateDisabled, "true");
  assert.ok(!invocation.args.includes("--conversation"));
  assert.ok(!invocation.args.includes("--print-timeout"));
  assert.match(invocation.input, /You are running in an empty directory outside the repository/);
  assert.match(invocation.input, new RegExp(`repository root:\\n${root}`));
  assert.equal(invocation.settings.permissions.allow[0], `read_file(${root})`);
});

test("[agy] a linked worktree can read its common Git directory", () => {
  const repo = changedRepo();
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "second");
  const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-backend-linked-")), "worktree");
  git(repo, "worktree", "add", "-b", "feature", linked);
  fs.writeFileSync(path.join(linked, "example.txt"), "linked\n", "utf8");
  assert.equal(review(linked).status, 0);
  const [invocation] = calls(logPath(linked));
  assert.ok(invocation.settings.permissions.allow.includes(`read_file(${path.join(resolveRepository(repo), ".git")})`));
});

test("[agy] Git's configuration is read as the reviewed repository sees it", () => {
  const repo = changedRepo();
  const root = resolveRepository(repo);
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-backend-config-")));
  const [global, conditional, local] = ["global", "conditional", "local"].map((name) => path.join(elsewhere, name));
  fs.writeFileSync(global, `[includeIf "gitdir:${root}/"]\n\tpath = ${conditional}\n`, "utf8");
  fs.writeFileSync(conditional, "[core]\n\tabbrev = 12\n", "utf8");
  fs.writeFileSync(local, "[core]\n\tabbrev = 13\n", "utf8");
  git(repo, "config", "include.path", local);
  const env = { ...process.env, ...B.env, [B.binEnv]: B.fake, [B.logEnv]: logPath(repo), GIT_CONFIG_GLOBAL: global };
  const result = command(process.execPath, [...ENTRY, "--dir", repo, "working"], { cwd: elsewhere, env, allowFailure: true });
  assert.equal(result.status, 0, result.stderr);
  const { allow } = calls(logPath(repo))[0].settings.permissions;
  for (const file of [global, conditional, local, path.join(root, ".git", "config")]) {
    assert.ok(allow.includes(`read_file(${file})`), `${file} is not in ${allow.join(", ")}`);
  }
});

test("[agy] the model carries the effort, a named model wins, and a resume names it again", () => {
  const repo = changedRepo();
  assert.equal(review(repo, ["working", "--effort", "high"]).status, 0);
  assert.equal(review(repo, ["again", "--model", "gemini-3.8-flash-low"]).status, 0);
  const [first, second] = calls(logPath(repo));
  assert.equal(first.model, "gemini-4-argon-high");
  assert.ok(!first.args.includes("--effort"));
  assert.equal(second.model, "gemini-3.8-flash-low");
  assert.equal(second.args[second.args.indexOf("--conversation") + 1], first.conversationId);
});

test("[agy] the artifact names the model that ran and its token usage", () => {
  const repo = changedRepo();
  const result = review(repo);
  assert.equal(result.status, 0);
  const artifact = result.stdout.match(/^Artifact: (.+)$/m)[1];
  const text = fs.readFileSync(artifact, "utf8");
  assert.match(text, /- Reported model: gemini-4-argon-medium/);
  assert.match(text, /- Token usage: 100 input \(20 cached\), 30 output \(5 thinking\)/);
});

for (const [shape, message] of [
  ["denied", /stopped to ask for approval.*npm test/],
  ["no-structured", /without the structured review the schema requires/],
  ["error", /Antigravity reported ERROR/],
  ["none", /ended without reporting a result/]
]) {
  test(`[agy] a turn that ends with ${shape} is a failed review, not an empty one`, () => {
    const repo = changedRepo();
    const result = review(repo, ["working"], { FAKE_AGY_RESULT: shape });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /## Verdict/);
    assert.match(review(repo, ["status"]).stdout, /Status: failed/);
  });
}

test("[agy] a process that hangs after its result is stopped, and the review still counts", () => {
  const repo = changedRepo();
  const started = Date.now();
  const result = review(repo, ["working"], { FAKE_AGY_HANG: "1" }, ["--import", SHORT_GRACE]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: completed/);
  assert.match(result.stdout, /Example defect/);
  assert.ok(Date.now() - started < 15_000);
});

test("[agy] a helper holding the pipes open after the result does not hold the review", () => {
  const repo = changedRepo();
  const result = review(repo, ["working"], { FAKE_AGY_HANG: "holder" }, ["--import", SHORT_GRACE]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: completed/);
});

test("[agy] a cancel stays a cancel when the stop after the result also fires", async () => {
  const repo = changedRepo();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-backend-marker-")), "result");
  const child = spawn(process.execPath, ["--import", SHORT_GRACE, ...ENTRY, "--dir", repo, "working"], {
    cwd: repo,
    stdio: "ignore",
    env: {
      ...process.env,
      ...B.env,
      [B.binEnv]: B.fake,
      [B.logEnv]: logPath(repo),
      FAKE_AGY_HANG: "1",
      FAKE_AGY_IGNORE_SIGTERM: "1",
      FAKE_AGY_RESULT_MARKER: marker,
      SHORT_RESULT_GRACE_MS: "1500"
    }
  });
  const closed = new Promise((resolve) => child.on("close", resolve));
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (!fs.existsSync(marker)) await pause(50);
  // The marker can outrun the pipe, and the runtime has to have read the result.
  await pause(300);
  child.kill("SIGTERM");
  await closed;
  assert.match(review(repo, ["status"]).stdout, /Status: cancelled/);
  const sessions = fs.readdirSync(path.join(repo, ...ARTIFACTS.split("/"))).filter((name) => /^\d{3}-/.test(name));
  const session = JSON.parse(fs.readFileSync(path.join(repo, ...ARTIFACTS.split("/"), sessions[0], "session.json"), "utf8"));
  assert.ok(!session.review_count, `the session counted ${session.review_count} reviews`);
});

test("[agy] a failure before any result still reports its exit", () => {
  const repo = changedRepo();
  const result = review(repo, ["working"], { FAKE_AGY_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Antigravity review failed \(exit 2\).*simulated Antigravity failure/s);
});
