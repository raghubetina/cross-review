# Codex Review

Ask Codex to review exact Git scopes from Claude Code. Reviews are read-only, default to maximum reasoning effort, run as detached background jobs, and keep one persistent Codex thread per review session, so a re-review remembers earlier findings and your decisions about them, across Claude Code sessions.

This is the inverse of [claude-review](https://github.com/raghubetina/claude-review), which asks Claude Code to review from Codex, and it keeps the same session model. It exists because the official Codex plugin for Claude Code starts every review in an ephemeral thread and drops its job state when the Claude Code session ends.

## Requirements

- Claude Code with plugin support (tested with 2.1.273)
- Codex CLI 0.136 or newer, installed and logged in (tested with 0.153.4)
- Node.js 18.18 or newer
- Git

## Install

From GitHub:

```text
/plugin marketplace add raghubetina/codex-review
/plugin install codex-review@codex-review
```

Or from a shell:

```sh
claude plugin marketplace add raghubetina/codex-review
claude plugin install codex-review@codex-review
```

During local development, load the plugin directly:

```sh
claude --plugin-dir /absolute/path/to/codex-review/plugins/codex-review
```

## Use

Ask naturally, or invoke the skill as `/codex-review:codex-review`:

```text
Have Codex review my working changes.
Ask Codex to review this branch against main.
Ask Codex to review the last commit, focusing on authorization.
Have Codex review ../another-repo.
Ask Codex to review it again. The callback API is intentionally retained for compatibility.
Continue Codex session SESSION_ID over only PRIOR_HEAD..HEAD.
```

Supported scopes are `working` (the default), `branch [base]`, `commit [ref]`, `range <from>..<to>`, and `repo`.
`again` repeats the previous scope in the current branch session. `--resume-session <session-id>` is the explicit
exact-scope path for resuming an active session when branch identity changes. It requires a clean, committed scope;
the stored tip must remain an ancestor of the current HEAD, the requested scope tip must equal that HEAD, and no
other active session may own the destination checkout identity. Only this explicit-resume path samples the
checkout's named-or-detached identity, HEAD, and cleanliness before invoking Codex and before applying the result.
Leave that checkout untouched while the review runs; a transient change restored between samples cannot be detected.

Once a Codex process starts, any error, timeout, cancellation, worker death, checkout mismatch, malformed result,
or persistence failure that prevents its result from being applied retires the plugin session at its last accepted
scope and HEAD. Cancellation therefore ends continuity. `again` explains why a retired session cannot resume; an
ordinary review starts a new isolated session and reports that transition. Review only the unapplied delta; session
continuity is optional and losing it does not justify replaying a broader scope. `new` starts a fresh session, and
`reset` forgets the active session without deleting its artifacts.

Reviews run in the background by default because Claude Code's Bash tool has a hard per-call time limit and a
max-effort review often outlasts it. The worker is detached from the shell, so it survives the end of the Bash call
and of the Claude Code session. `status`, `result`, and `cancel` manage jobs; `result --wait` blocks for up to
`--wait-minutes` (default 5) and can be called again to keep waiting.

## Review artifacts

Each reviewed repository gets an ignored `tmp/codex_reviews/` directory containing sequenced review artifacts, session metadata, and background-job state. If necessary, the plugin adds `tmp/codex_reviews/` to Git's local `info/exclude`; it does not modify the repository's tracked `.gitignore`.

Codex receives a bounded, secret-filtered Git context over stdin and runs with a read-only sandbox, approvals set to never, and MCP servers disabled. The thread is persisted in Codex's own session store, so every result also prints a thread ID that `codex resume <thread-id>` can open interactively.

## Develop

```sh
npm test
```

The test suite uses disposable Git repositories and a fake Codex executable. It covers scope resolution, automatic
and explicit session resumption, advancing detached review worktrees, same-SHA checkout identity changes, retired
sessions, background jobs, waiting, cancellation, pre- and post-application worker recovery, legacy job state, large
diffs, history replacement, failures, and safe invocation arguments.

After installing a development build, verify that Claude Code resolves the bundled runtime without starting a Codex review:

```sh
claude -p --plugin-dir /absolute/path/to/codex-review/plugins/codex-review \
  'Use the codex-review skill to run only the bundled runtime help. Do not run a review. Report the absolute script path it ran.'
```

The output should begin with `Codex Review` and the reported path should be inside the plugin directory.
