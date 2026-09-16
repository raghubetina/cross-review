// Codex backend: Claude Code asks Codex to review through `codex exec`.

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const SANDBOX_MODE = { full: "danger-full-access", workspace: "workspace-write", "read-only": "read-only" };
const FULL_PROMPT = {
  tools: "Use shell commands, git, and any MCP tools available to you when you need surrounding code, repository-wide inspection, or to verify a finding by running it.",
  repoScope: "Inspect the repository with shell commands such as ls, cat, rg, and git.",
  truncation: "Inspect the listed files directly with shell commands."
};

function parseEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Codex may interleave non-JSON diagnostics with its JSONL event stream.
    }
  }
  return events;
}

function formatUsage(usage) {
  if (!usage) return "unknown";
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const reasoning = usage.reasoning_output_tokens ?? 0;
  return `${input} input (${cached} cached), ${output} output (${reasoning} reasoning)`;
}

export default {
  name: "codex",
  reviewerLabel: "Codex",
  artifactDirectory: "tmp/codex_reviews",
  binaryEnv: "CODEX_REVIEW_CODEX_BIN",
  defaultBinary: "codex",
  versionLabel: "Codex CLI",
  minVersion: [0, 136, 0],
  installHint: "Install it with npm install -g @openai/codex, run codex login, and retry.",
  effortLevels: EFFORT_LEVELS,
  defaultEffort: "max",
  conversationStrategy: "assigned",
  conversationLabel: "Codex thread ID",
  resumeHint: (id) => `codex resume ${id}`,
  extraOptions: {},
  usesLastMessageFile: true,
  prompt: {
    full: FULL_PROMPT,
    workspace: FULL_PROMPT,
    "read-only": {
      tools: "Use read-only commands such as cat, sed, rg, ls, and git show/log/diff only when you need surrounding code or repository-wide inspection.",
      repoScope: "Inspect the repository with read-only commands such as ls, cat, rg, and git.",
      truncation: "Inspect the listed files directly with read-only commands."
    }
  },

  buildArgs({ job, session, schemaPath, lastMessagePath, scratchDir, capability }) {
    const shared = [
      "--json",
      "--output-schema", schemaPath,
      "-o", lastMessagePath,
      "--skip-git-repo-check",
      "-c", `model_reasoning_effort=${JSON.stringify(job.effort)}`,
      "-c", `sandbox_mode=${JSON.stringify(SANDBOX_MODE[capability])}`,
      "-c", 'approval_policy="never"'
    ];
    if (capability === "workspace") {
      shared.push(
        "-c", "sandbox_workspace_write.network_access=true",
        "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([scratchDir])}`
      );
    }
    if (job.model) shared.push("-m", job.model);
    if (job.resumed) return ["exec", "resume", session.conversation_id, "-", ...shared];
    return ["exec", "-", ...shared];
  },

  earlyConversationId(line) {
    if (!line.startsWith("{")) return null;
    try {
      const event = JSON.parse(line);
      return event?.type === "thread.started" && typeof event.thread_id === "string" ? event.thread_id : null;
    } catch {
      return null;
    }
  },

  parseOutput({ stdout, lastMessage }) {
    const events = parseEvents(stdout);
    const failure = events.find((event) => event?.type === "turn.failed" || event?.type === "error");
    if (failure) {
      const detail = failure.error?.message ?? failure.message ?? JSON.stringify(failure);
      throw new Error(`Codex reported an error: ${detail}`);
    }
    const conversationId = events.find((event) => event?.type === "thread.started")?.thread_id ?? null;
    const agentMessages = events
      .filter((event) => event?.type === "item.completed" && event.item?.type === "agent_message")
      .map((event) => (typeof event.item.text === "string" ? event.item.text : ""));
    const rawResult = (typeof lastMessage === "string" && lastMessage.trim())
      ? lastMessage.trim()
      : (agentMessages.at(-1) ?? "").trim();
    if (!conversationId && !rawResult) {
      throw new Error("Codex returned neither a thread ID nor a final message.");
    }
    let candidate = null;
    try {
      candidate = JSON.parse(rawResult);
    } catch {
      // Preserve free-form output as degraded rather than inventing structure.
    }
    const usage = events
      .filter((event) => event?.type === "turn.completed" && event.usage && typeof event.usage === "object")
      .map((event) => event.usage)
      .at(-1) ?? null;
    return { candidate, rawResult, conversationId, usage };
  },

  artifactLines({ parsedOutput }) {
    return [`- Token usage: ${formatUsage(parsedOutput?.usage)}`];
  }
};
