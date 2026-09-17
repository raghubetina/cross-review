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

Reviews run as detached background jobs by default because Claude Code caps each Bash call and a max-effort review often outlasts it; `result --wait` blocks for up to `--wait-minutes` (default 5) and can be called again. Every result prints a plugin session ID and the Codex thread ID, which `codex resume <thread-id>` opens interactively. Artifacts live in the reviewed repository's ignored `tmp/codex_reviews/` directory.

Details: [SKILL.md](plugins/codex-review/skills/codex-review/SKILL.md) and [interface.md](plugins/codex-review/skills/codex-review/references/interface.md).

## claude-review (Codex asks Claude Code)

Requirements: Codex with plugin support, Claude Code 2.1.205 or newer installed and authenticated, Node.js 18.18 or newer, Git.

```sh
codex plugin marketplace add raghubetina/cross-review
codex plugin add claude-review@cross-review
```

During local development: `codex plugin marketplace add /absolute/path/to/cross-review` then the same `codex plugin add`. After installation, start a new Codex process; in the ChatGPT desktop app, fully quit and reopen it so it rescans marketplaces. In Codex CLI, invoke the skill with `$claude-review`; `/claude-review` is not a slash command.

Reviews default to maximum reasoning effort and can run in the background; `result --wait` blocks for up to `--wait-minutes` (default 5). Claude receives a bounded, secret-filtered Git context over stdin. Every result prints a plugin session ID and the Claude session ID, which `claude --resume <session-id>` opens interactively. Artifacts live in the reviewed repository's ignored `tmp/claude_reviews/` directory.

Details: [SKILL.md](plugins/claude-review/skills/claude-review/SKILL.md) and [interface.md](plugins/claude-review/skills/claude-review/references/interface.md).

## Session semantics, shared by both

`again` repeats the previous scope in the current branch session. `--resume-session <session-id>` is the explicit exact-scope path for resuming an active session when branch identity changes. It requires a clean, committed scope; the stored tip must remain an ancestor of the current HEAD, the requested scope tip must equal that HEAD, and no other active session may own the destination checkout identity. Only this explicit-resume path samples the checkout's named-or-detached identity, HEAD, and cleanliness before invoking the reviewer and before applying the result. Leave that checkout untouched while the review runs; a transient change restored between samples cannot be detected.

Once a reviewer process starts, any error, timeout, cancellation, worker death, checkout mismatch, malformed result, or persistence failure that prevents its result from being applied retires the plugin session at its last accepted scope and HEAD. Cancellation therefore ends continuity. `again` explains why a retired session cannot resume; an ordinary review starts a new isolated session and reports that transition. `new` starts a fresh session, and `reset` forgets the active session without deleting its artifacts. If necessary, each plugin adds its artifact directory to Git's local `info/exclude`; neither modifies the tracked `.gitignore`.

## Result format

Every review returns a verdict, a terse summary, findings, next steps, and residual risk, enforced by a JSON schema. Each finding carries an id (`F-` plus six hex characters, assigned by the runtime and shown back to the reviewer in every later round), an observation (`new`, `persisting`, `fixed`, or `reopen_proposed`), a severity (`critical`, `high`, `medium`, `low`, defined in the prompt with Codex's P0 to P3 meanings), a location, whether it is pre-existing, the trigger, quoted evidence, a confidence, and a recommendation. The runtime sorts findings by severity then confidence, flags a repeated id or a missing location, and records every finding in the session's ledger. The prompt embeds a rubric adapted from Codex's own review rubric (see NOTICE) plus the false-positive rules from Anthropic's code-review plugin: nothing a linter or compiler would catch, no pre-existing issues on untouched lines in change scopes, no nits a senior engineer would not raise.

## Decisions

Your verdict on a finding is a decision, written anywhere in the focus text: `reject F-1a2b3c: reason`, `accept F-...`, `defer F-...`, or `reopen F-...`. The runtime records it before the reviewer starts, so it survives a failed review or a retired session, and it shows every prior finding with its observation, disposition, and decision to the reviewer in each later round. Reviewer output never changes a disposition: a rejected finding can only come back as a reopen proposal with new evidence. When a retired session is replaced, or the branch history is rewritten under an active session, the new session inherits the ledger and says so; `new` starts without it. An id printed with a `resembles` flag folds into the earlier finding before the next round and stays usable as an alias.

## What the reviewer receives

Every review starts from a filtered view of the change: files whose names look like credentials (`.env*`, `.netrc`, `.npmrc`, `.pypirc`, `.htpasswd`, `credentials*`, `secrets*`, `token*`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.tfvars`, `*.jks`, `*.keystore`, `*.kdbx`) are left out by name, and any patch or untracked file whose content looks like a private key or an access key is left out by content. The prompt lists what was omitted and tells the reviewer not to open it. Committed scopes always include the commit log, the diff stat, and the base, merge-base, and head SHAs.

A change of at most 256 KB and 40 files is inlined, untracked files included up to 512 KB each and 2 MB in total. A larger change is summarized instead and the patch is handed over one of two ways: a reviewer that can run git gets the file list and the exact `git diff` command per file; Claude in `read-only` mode, which cannot, gets per-file patch files and the whole diff written under the session's task directory to read with its file tools. Both routes come from the same filtered view, so an omitted file is omitted everywhere.

## Reviewer capabilities

The reviewer is the same agent you already trust to write code, so by default it can do whatever that agent can: run tests, write scratch code, install tools, download libraries, drive browsers, and call any MCP servers, hooks, and settings from your own Codex or Claude Code configuration. `--capability` selects the mode per review:

| Mode | Codex backend | Claude backend |
| --- | --- | --- |
| `full` (default) | no sandbox, approvals never | `--permission-mode bypassPermissions`, all tools |
| `workspace` | `workspace-write` sandbox with network: the checkout, `/tmp`, and scratch are writable, `.git` is protected, so no commits, stashes, or ref changes | same as `full` (Claude Code has no OS sandbox in headless mode) |
| `read-only` | `read-only` sandbox, approvals never | `--tools Read,Glob,Grep --permission-mode dontAsk --setting-sources user` |

Each session has a scratch directory at `<artifact directory>/<task>/scratch/`, already ignored by Git, which the prompt names as the only place inside the repository the reviewer may create files; it persists across review rounds so a test harness from round one is reusable. The prompt also tells the reviewer to leave the checkout as found: no edits to tracked files, no new files outside scratch, no git commands that change refs, the index, the stash, or the working tree, and never a commit or push. After the review the runtime compares HEAD, refs, the dirty set by content, newly ignored paths, and `.git` config and hooks with what it saw before, and reports any difference as a warning naming the paths, on the job, in the artifact, and in the rendered result, on success and failure alike. Ignored paths that already existed are not compared. If HEAD moved, the session keeps the pre-review HEAD as its last reviewed commit, so a stray commit can be undone without losing continuity. Explicit `--resume-session` reviews still fail on any change. In `full` and `workspace` the Claude backend behaves like a normal session in the reviewed repository, its `.claude/settings.json` hooks included; `read-only` loads only your user settings so a repository you do not trust cannot run hooks, and the reviewer runs with your own privileges and network in every mode.

## Develop

```sh
npm test
```

Runs one suite, parametrized over both backends, against disposable Git repositories with fake `claude` and `codex` executables.

The shared runtime lives in `src/runtime.mjs` with one backend module per reviewer in `src/backends/`. Each plugin's `scripts/` directory holds a five-line entry plus committed copies of the runtime and its backend, because both hosts copy an installed plugin out of the repository. After editing `src/`, run `npm run build` to refresh the copies; the test suite fails while a copy is stale.

Verify an installed development build without starting a review:

```sh
claude -p --plugin-dir /absolute/path/to/cross-review/plugins/codex-review \
  'Use the codex-review skill to run only the bundled runtime help. Do not run a review. Report the absolute script path it ran.'

codex exec --ephemeral --sandbox read-only --cd /path/to/a/git/repository \
  'Use $claude-review to run only the bundled runtime help. Do not run a review. Report the absolute installed script path.'
```

The first should report a path inside the plugin directory and output beginning with `Codex Review`; the second a path under Codex's plugin cache and output beginning with `Claude Review`.
