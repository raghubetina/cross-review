// Antigravity backend: another agent asks Antigravity CLI to review through `agy`.
// docs/unification-plan.md section 11 records the runs behind these choices.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTH_SETTING = "CROSS_REVIEW_AGY_AUTH";
const DEFAULT_MODEL = "gemini-4-argon";
const EFFORT_LEVELS = ["low", "medium", "high"];

function parseEvent(line) {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseEvents(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => parseEvent(line.trim())).filter(Boolean);
}

function formatUsage(usage) {
  if (!usage) return "unknown";
  const input = usage.input_tokens ?? 0;
  const cached = usage.cache_read_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const thinking = usage.thinking_tokens ?? 0;
  return `${input} input (${cached} cached), ${output} output (${thinking} thinking)`;
}

// Git stops with "unable to access" when the sandbox hides a config file it was
// told to read, or a linked worktree's common directory, so each needs a grant.
// Asked from the repository, because conditional includes depend on where it is.
function pathsGitReads(repoRoot) {
  const git = (...args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  const configs = git("config", "--includes", "--list", "--show-origin", "--name-only", "-z").stdout ?? "";
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout?.trim();
  const files = configs.split("\0")
    .filter((entry) => entry.startsWith("file:"))
    .map((entry) => path.resolve(repoRoot, entry.slice("file:".length)));
  return [...new Set([common, ...files].filter(Boolean))];
}

function enclosingRepository(directory) {
  let current = fs.realpathSync(directory);
  while (!fs.existsSync(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export default {
  name: "agy",
  reviewerLabel: "Antigravity",
  artifactDirectory: "tmp/agy_reviews",
  binaryEnv: "CROSS_REVIEW_AGY_BIN",
  defaultBinary: "agy",
  versionLabel: "Antigravity CLI",
  minVersion: [1, 5, 1],
  installHint: "Install Antigravity CLI from https://antigravity.google, sign in by running agy, and retry.",
  // `agy` passes --effort max through its help text but exits 1 on it, and the
  // model names carry the level anyway.
  effortLevels: EFFORT_LEVELS,
  // In tests on AI Pro, a review of up to 256 KB at medium took a little over 1% of
  // Gemini 4 Argon's weekly allowance.
  defaultEffort: "medium",
  // A reviewed repository's hooks and MCP commands run with no trust prompt
  // wherever `agy` starts, even under --sandbox, so it only ever starts elsewhere,
  // where it cannot run the repository's tests.
  capabilities: ["read-only"],
  explicitOnly: true,
  usageNote: `agy runs only when named, and only after you opt in with ${AUTH_SETTING}=login.`,
  conversationStrategy: "assigned",
  conversationLabel: "Antigravity conversation ID",
  resumeHint: (id) => `agy --conversation ${id}`,
  extraOptions: {},
  usesLastMessageFile: false,
  canRunGit: () => true,
  // Reports say `agy` can hang after printing its result; it normally exits within a second.
  resultGraceMs: 30_000,
  prompt: {
    "read-only": {
      tools: "You are running in an empty directory outside the repository, so give every tool an absolute path under the repository root above and run git as git -C followed by that root. Use your file tools and read-only git commands only when you need surrounding code or repository-wide inspection.",
      repoScope: "Inspect the repository with your file tools and read-only git commands, using absolute paths under the repository root.",
      truncation: "Inspect the listed files directly, using absolute paths under the repository root."
    }
  },

  refusal(env) {
    if (env[AUTH_SETTING] !== "login") {
      return `The agy reviewer is off until you opt in, because Google's FAQ and terms conflict on using a consumer login this way. Read "Antigravity and Google's terms" in the cross-review README, then set ${AUTH_SETTING}=login in your environment.`;
    }
    // `agy` reads .agents/, which can hold hooks and MCP servers, from each parent
    // of where it starts up to the repository root, so that start must be in none.
    const repository = enclosingRepository(os.tmpdir());
    if (repository) {
      return `The temporary directory ${os.tmpdir()} is inside the Git repository ${repository}, so Antigravity would load that repository's hooks and MCP servers. Point TMPDIR outside any repository and retry.`;
    }
    return null;
  },

  spawnOptions({ env }) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-agy-"));
    return {
      cwd,
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      cleanup: () => fs.rmSync(cwd, { recursive: true, force: true })
    };
  },

  buildArgs({ job, session, schemaPath }) {
    const readable = [job.repo_root, ...pathsGitReads(job.repo_root)];
    const settings = {
      toolPermission: "proceed-in-sandbox",
      permissions: { deny: ["write_file(*)"], allow: readable.map((entry) => `read_file(${entry})`) }
    };
    const args = [
      "--output-format", "stream-json",
      "--json-schema", schemaPath,
      "--disable-slash-commands",
      "--sandbox",
      "--settings", JSON.stringify(settings),
      // Always named, because a resumed conversation does not inherit its model
      // and `agy` also serves other companies' models.
      "--model", job.model ?? `${DEFAULT_MODEL}-${job.effort}`
    ];
    if (job.resumed) args.push("--conversation", session.conversation_id);
    return args;
  },

  earlyConversationId(line) {
    const conversationId = parseEvent(line)?.conversation_id;
    return typeof conversationId === "string" ? conversationId : null;
  },

  isTerminalEvent(line) {
    return parseEvent(line)?.event === "result";
  },

  // A tool that needs approval ends the turn with exit 0, status SUCCESS, and an
  // empty response, so only the structured output counts. `response` joins every
  // attempt at the schema, invalid ones included, so nothing else is read from it.
  parseOutput({ stdout }) {
    const events = parseEvents(stdout);
    const result = events.filter((event) => event.event === "result").at(-1)?.result;
    if (!result) throw new Error("Antigravity ended without reporting a result.");
    if (result.status !== "SUCCESS") throw new Error(`Antigravity reported ${result.status}.`);
    if (result.denied_actions?.length) {
      throw new Error(`Antigravity stopped to ask for approval, so it did not finish: ${JSON.stringify(result.denied_actions).slice(0, 1000)}`);
    }
    if (!result.structured_output) throw new Error("Antigravity finished without the structured review the schema requires.");
    const model = events.find((event) => event.event === "init")?.init?.model;
    return {
      candidate: result.structured_output,
      rawResult: JSON.stringify(result.structured_output),
      conversationId: result.conversation_id ?? null,
      usage: result.usage ?? null,
      models: model ? [model] : []
    };
  },

  artifactLines({ parsedOutput }) {
    return [
      `- Reported model: ${parsedOutput?.models?.join(", ") || "unknown"}`,
      `- Token usage: ${formatUsage(parsedOutput?.usage)}`
    ];
  }
};
