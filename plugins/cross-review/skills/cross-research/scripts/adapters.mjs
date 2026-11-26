// What research changes about how each backend's CLI runs. The backends in
// ../../cross-review/scripts/backends/ build a review invocation; a researcher
// also needs the web, and is told what it can reach with.

function replaceValueAfter(args, flag, change) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`The backend's arguments have no ${flag} to adjust for research.`);
  const next = [...args];
  next[index + 1] = change(args[index + 1]);
  return next;
}

function codexActivity(stdout) {
  const counts = { web_search: 0, command_execution: 0, mcp_tool_call: 0 };
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Codex may interleave diagnostics with its event stream.
      continue;
    }
    if (event?.type === "item.completed" && Object.hasOwn(counts, event.item?.type)) counts[event.item.type] += 1;
  }
  const parts = [
    [counts.web_search, "web search", "web searches"],
    [counts.command_execution, "command", "commands"],
    [counts.mcp_tool_call, "MCP call", "MCP calls"]
  ].filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : null;
}

const WRITING_TOOLS = {
  codex: "Use everything you have: web search, shell commands with network access such as git clone, curl, gh, and package managers, and any MCP tools available to you.",
  claude: "Use everything you have: WebSearch, WebFetch, Bash with network access for git clone, curl, gh, and package managers, and any MCP servers available to you."
};

const ADAPTERS = {
  codex: {
    // Codex answers from a search cache unless it is told to search live.
    args: (args) => [...args, "-c", 'web_search="live"'],
    writes: (capability) => capability !== "read-only",
    tools: {
      full: WRITING_TOOLS.codex,
      workspace: WRITING_TOOLS.codex,
      "read-only": "Use web search and read-only shell commands. Your shell has no network access and you cannot write files, so you cannot clone or download; cite what you read through web search and in the repository."
    },
    activity: codexActivity
  },
  claude: {
    // The review backend's read-only mode has no web tools, and its permission
    // mode refuses a tool that is not allowed by name.
    args: (args, capability) => (capability === "read-only"
      ? [...replaceValueAfter(args, "--tools", (tools) => `${tools},WebSearch,WebFetch`), "--allowedTools", "WebSearch,WebFetch"]
      : args),
    writes: (capability) => capability !== "read-only",
    tools: {
      full: WRITING_TOOLS.claude,
      workspace: WRITING_TOOLS.claude,
      "read-only": "Use WebSearch, WebFetch, Read, Glob, and Grep. You cannot run commands or write files, so you cannot clone or download; cite what you read on the web and in the repository."
    },
    activity: () => null
  },
  agy: {
    // Reading a page asks for approval by default, and a headless run that
    // asks ends its turn with nothing.
    args: (args) => replaceValueAfter(args, "--settings", (json) => {
      const settings = JSON.parse(json);
      settings.permissions.allow = [...(settings.permissions.allow ?? []), "read_url(*)"];
      return JSON.stringify(settings);
    }),
    writes: () => false,
    tools: {
      "read-only": "You are running in an empty directory outside the repository, so give every file tool an absolute path under the repository root above. Use web search and page reading. You cannot write files, clone, or download, so cite what you read on the web and in the repository."
    },
    activity: () => null
  }
};

const GENERIC = {
  args: (args) => args,
  writes: (capability) => capability !== "read-only",
  tools: {},
  activity: () => null
};

export function adapterFor(backend) {
  const adapter = ADAPTERS[backend.name] ?? GENERIC;
  return {
    args: adapter.args,
    writes: adapter.writes,
    activity: adapter.activity,
    tools: (capability) => adapter.tools[capability] ?? "Use every tool you have to search the web, read sources in full, and inspect the repository."
  };
}
