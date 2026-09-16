# Cross Review

Two plugins that let each coding agent ask the other for a code review of an exact Git scope, keeping one persistent reviewer conversation per repository and branch session so a re-review remembers earlier findings and your decisions about them.

| Plugin | Host | Reviewer | Invoke |
| --- | --- | --- | --- |
| `codex-review` | Claude Code | Codex | ask naturally, or `/codex-review:codex-review` |
| `claude-review` | Codex | Claude Code | ask naturally, or `$claude-review` |

Both share the same session model: explicit scopes (`working`, `branch [base]`, `commit [ref]`, `range <from>..<to>`, `repo`), `again` to re-review in the same conversation, `--resume-session` for exact resumes across branch identity changes, detached background jobs with `status`, `result`, and `cancel`, secret-filtered Git context on stdin, and a JSON-schema-enforced result. The roadmap that merges the two runtimes into one shared core is in [docs/unification-plan.md](docs/unification-plan.md).

## codex-review (Claude Code asks Codex)

Requirements: Claude Code with plugin support (tested with 2.1.273), Codex CLI 0.136 or newer installed and logged in (tested with 0.153.4), Node.js 18.18 or newer, Git.

```text
/plugin marketplace add raghubetina/cross-review
/plugin install codex-review@cross-review
```

Or from a shell: `claude plugin marketplace add raghubetina/cross-review` then `claude plugin install codex-review@cross-review`. During development: `claude --plugin-dir /absolute/path/to/cross-review/plugins/codex-review`.

Reviews run as detached background jobs by default because Claude Code caps each Bash call and a max-effort review often outlasts it; `result --wait` blocks for up to `--wait-minutes` (default 5) and can be called again. Every result prints a plugin session ID and the Codex thread ID, which `codex resume <thread-id>` opens interactively. Codex runs with a read-only sandbox and approvals set to never, and inherits your Codex configuration, MCP servers included. Artifacts live in the reviewed repository's ignored `tmp/codex_reviews/` directory.

Details: [SKILL.md](plugins/codex-review/skills/codex-review/SKILL.md) and [interface.md](plugins/codex-review/skills/codex-review/references/interface.md).

## claude-review (Codex asks Claude Code)

Requirements: Codex with plugin support, Claude Code 2.1.205 or newer installed and authenticated, Node.js 18.18 or newer, Git.

```sh
codex plugin marketplace add raghubetina/cross-review
codex plugin add claude-review@cross-review
```

During local development: `codex plugin marketplace add /absolute/path/to/cross-review` then the same `codex plugin add`. After installation, start a new Codex process; in the ChatGPT desktop app, fully quit and reopen it so it rescans marketplaces. In Codex CLI, invoke the skill with `$claude-review`; `/claude-review` is not a slash command.

Reviews are read-only, default to maximum reasoning effort, and can run in the background. Claude receives a bounded, secret-filtered Git context over stdin and only the `Read`, `Glob`, and `Grep` tools. Artifacts live in the reviewed repository's ignored `tmp/claude_reviews/` directory.

Details: [SKILL.md](plugins/claude-review/skills/claude-review/SKILL.md) and [interface.md](plugins/claude-review/skills/claude-review/references/interface.md).

## Session semantics, shared by both

`again` repeats the previous scope in the current branch session. `--resume-session <session-id>` is the explicit exact-scope path for resuming an active session when branch identity changes. It requires a clean, committed scope; the stored tip must remain an ancestor of the current HEAD, the requested scope tip must equal that HEAD, and no other active session may own the destination checkout identity. Only this explicit-resume path samples the checkout's named-or-detached identity, HEAD, and cleanliness before invoking the reviewer and before applying the result. Leave that checkout untouched while the review runs; a transient change restored between samples cannot be detected.

Once a reviewer process starts, any error, timeout, cancellation, worker death, checkout mismatch, malformed result, or persistence failure that prevents its result from being applied retires the plugin session at its last accepted scope and HEAD. Cancellation therefore ends continuity. `again` explains why a retired session cannot resume; an ordinary review starts a new isolated session and reports that transition. `new` starts a fresh session, and `reset` forgets the active session without deleting its artifacts. If necessary, each plugin adds its artifact directory to Git's local `info/exclude`; neither modifies the tracked `.gitignore`.

## Develop

```sh
npm test
```

Runs both suites against disposable Git repositories with fake `claude` and `codex` executables.

Verify an installed development build without starting a review:

```sh
claude -p --plugin-dir /absolute/path/to/cross-review/plugins/codex-review \
  'Use the codex-review skill to run only the bundled runtime help. Do not run a review. Report the absolute script path it ran.'

codex exec --ephemeral --sandbox read-only --cd /path/to/a/git/repository \
  'Use $claude-review to run only the bundled runtime help. Do not run a review. Report the absolute installed script path.'
```

The first should report a path inside the plugin directory and output beginning with `Codex Review`; the second a path under Codex's plugin cache and output beginning with `Claude Review`.
