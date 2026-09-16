// Claude backend: Codex asks Claude Code to review through `claude -p`.

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const FULL_PROMPT = {
  tools: "Use your tools, including Bash, file reads, and any MCP servers available to you, when you need surrounding code, repository-wide inspection, or to verify a finding by running it.",
  repoScope: "Inspect the repository with your tools.",
  truncation: "Inspect the listed files directly."
};

export default {
  name: "claude",
  reviewerLabel: "Claude",
  artifactDirectory: "tmp/claude_reviews",
  binaryEnv: "CLAUDE_REVIEW_CLAUDE_BIN",
  defaultBinary: "claude",
  versionLabel: "Claude Code",
  minVersion: [2, 1, 205],
  installHint: "Install or authenticate Claude Code and retry.",
  effortLevels: EFFORT_LEVELS,
  defaultEffort: "max",
  conversationStrategy: "chosen",
  conversationLabel: "Claude session ID",
  resumeHint: (id) => `claude --resume ${id}`,
  extraOptions: {
    "--max-budget-usd": {
      key: "max_budget_usd",
      usage: "  --max-budget-usd <amount>    Pass an API billing cap to Claude Code"
    }
  },
  usesLastMessageFile: false,
  prompt: {
    full: FULL_PROMPT,
    workspace: FULL_PROMPT,
    "read-only": {
      tools: "Use Read, Glob, and Grep only when you need surrounding code or repository-wide inspection.",
      repoScope: "Use Read, Glob, and Grep to inspect the repository.",
      truncation: "Use Read/Glob/Grep to inspect listed files directly."
    }
  },

  buildArgs({ job, session, schema, capability }) {
    const args = ["-p"];
    if (capability === "read-only") args.push("--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep");
    else args.push("--permission-mode", "bypassPermissions");
    args.push(
      "--effort", job.effort,
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema)
    );
    if (job.model) args.push("--model", job.model);
    const budget = job.backend_options?.max_budget_usd ?? null;
    if (budget !== null) args.push("--max-budget-usd", String(budget));
    if (job.resumed) args.push("--resume", session.conversation_id);
    else args.push("--session-id", session.conversation_id);
    return args;
  },

  parseOutput({ stdout }) {
    let envelope;
    try {
      envelope = JSON.parse(String(stdout).trim());
    } catch (error) {
      throw new Error(`Claude returned malformed JSON: ${error.message}`);
    }
    const resultEnvelope = Array.isArray(envelope)
      ? [...envelope].reverse().find((item) => item?.type === "result") ?? envelope.at(-1)
      : envelope;
    if (!resultEnvelope || resultEnvelope.is_error) {
      throw new Error(`Claude reported an error: ${resultEnvelope?.result ?? resultEnvelope?.subtype ?? "unknown error"}`);
    }
    let candidate = resultEnvelope.structured_output ?? null;
    if (!candidate && typeof resultEnvelope.result === "string") {
      try {
        candidate = JSON.parse(resultEnvelope.result);
      } catch {
        // Preserve free-form output as degraded rather than inventing structure.
      }
    }
    const modelUsage = resultEnvelope.modelUsage ?? resultEnvelope.model_usage ?? {};
    return {
      candidate,
      rawResult: typeof resultEnvelope.result === "string" ? resultEnvelope.result : "",
      conversationId: resultEnvelope.session_id ?? null,
      usage: null,
      models: Object.keys(modelUsage)
    };
  },

  artifactLines({ parsedOutput }) {
    return [`- Reported models: ${parsedOutput?.models?.join(", ") || "unknown"}`];
  }
};
