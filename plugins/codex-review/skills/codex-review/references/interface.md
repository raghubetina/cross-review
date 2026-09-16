# Codex Review Runtime Interface

## Review scopes

```text
codex-review.mjs                               working tree, current repository
codex-review.mjs working                      staged, unstaged, and untracked work
codex-review.mjs branch [base]                merge-base-to-HEAD branch change
codex-review.mjs commit [ref]                 one commit, default HEAD
codex-review.mjs range <from>..<to>           explicit two-dot range
codex-review.mjs repo                         whole repository
codex-review.mjs again                        previous scope in the active session
codex-review.mjs new [scope]                  new session, then review
codex-review.mjs reset                        forget active session; retain artifacts
```

Every review result prints its plugin session ID and its Codex thread ID. The session ID is what `--resume-session`
takes. The thread ID names the persisted Codex conversation; `codex resume <thread-id>` opens it interactively.

To resume an exact active session with a new scope after the branch identity changes, including when an
exact-commit review worktree advances to a descendant, pass:

```text
codex-review.mjs --resume-session <session-id> range <prior-head>..<current-head> [-- focus]
```

The selected session must remain active in the same working-tree root and use a clean checkout with a committed
scope (`branch`, `commit`, `range`, or `repo`); working scope and `--include-working` are rejected. It must have a
completed review whose stored scope and HEAD identify the same recorded commit tip, keep that tip as an ancestor of
the current HEAD, and target a new scope whose committed tip equals that HEAD. No other active session may already
own the destination checkout identity. A successful resume follows the current checkout identity. A sibling linked
worktree has separate session storage. Pass the ID again after each
detached HEAD change, and leave that working tree untouched until the resumed review finishes. The runtime samples
its named-or-detached identity, HEAD, and cleanliness before invoking Codex and before applying the result; these
samples apply only to explicit `--resume-session` reviews, and cannot detect a transient change restored between
them. Background execution may overlap work in another checkout.

Once a Codex process starts, any error, timeout, cancellation, worker death, checkout mismatch, malformed result,
or persistence failure that prevents its result from being applied retires the plugin session at its last accepted
scope and HEAD. Cancellation ends continuity. `again` then reports why it cannot resume, while an ordinary review
starts a new isolated session and reports the transition. Review the unapplied delta; optional continuity does not
require a broader replay. `again` normally repeats the selected session's previous scope definition; use an explicit
range for a focused delta. Use `new` when history, review scope, or intended context should not continue.

Put custom focus or follow-up feedback after `--`:

```text
codex-review.mjs branch main -- Focus on authorization and tenant isolation
codex-review.mjs again -- The callback API is intentionally retained for compatibility
```

The runtime also accepts trailing focus text without `--` when unambiguous.

## Options

```text
--dir <path>                 target another repository
--resume-session <id>        resume this repository's prior active session
--model <model>              explicitly select and persist a Codex model for this session
--effort <level>             minimal, low, medium, high, xhigh, max, or ultra; default max
--capability <mode>          full (default), workspace, or read-only; see below
--include-working            add local changes to branch, commit, or range scope
--background                 start a persistent, detached background job
--wait                       run a review in the foreground; with status or result, block until the job ends
--wait-minutes <number>      longest a status or result --wait call blocks; default 5
--timeout-minutes <number>   hard timeout for the Codex process; default 30
```

## Reviewer capabilities

`full` gives the reviewer everything the Codex agent can normally do, including your MCP servers, hooks, and
settings. `workspace` keeps the `workspace-write` sandbox with network access: the checkout, `/tmp`, and the scratch
directory are writable, and `.git` is protected so Codex cannot commit, stash, or move refs. `read-only` uses the
read-only sandbox.

Every session has a scratch directory at `<task directory>/scratch/`, ignored by Git and named in the prompt as the
only place inside the repository the reviewer may create files; it persists across rounds. The prompt tells the
reviewer to leave the checkout as found and never commit or push. After the review, on success or failure, the
runtime compares HEAD, refs, the dirty set by content, newly ignored paths, and `.git` config and hooks with what
it saw before; any difference becomes a `Warning:` line naming the paths in the result and a warning section in
the artifact. If HEAD moved, the session keeps the pre-review HEAD as its last reviewed commit. Explicit
`--resume-session` reviews still fail on any change.

## Job controls

```text
codex-review.mjs status [job-id] [--wait] [--dir <path>]
codex-review.mjs result [job-id] [--wait] [--dir <path>]
codex-review.mjs cancel [job-id] [--dir <path>]
```

When no job ID is supplied, operate on the latest applicable job. With `--wait`, `status` and `result` poll the job
until it reaches a terminal status or `--wait-minutes` elapses, then print it; a still-running job says so, and
another `--wait` call keeps waiting.

## Important mappings

- “Review what I have changed” → `working --background`
- “Review this branch against main” → `branch main --background`
- “Review the last commit” → `commit HEAD --background`
- “Review commit abc123” → `commit abc123 --background`
- “Review everything since v1.2” → `range v1.2..HEAD --background`
- “Review the architecture/codebase” → `repo --background`
- “Review it again” → `again --background`
- “Continue session X over only these fixes” → `--resume-session X range PRIOR_HEAD..HEAD --background`
- “Start over with Codex” → `new`
- “Forget that review thread” → `reset`
- “Is the review done?” → `status`, or `result --wait` to block for the result
