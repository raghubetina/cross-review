# Cross Review Runtime Interface

## Reviewers

The reviewer comes first on the command line and is `codex`, `claude`, or `agy`. Each keeps its own sessions and
artifacts, under `tmp/codex_reviews`, `tmp/claude_reviews`, and `tmp/agy_reviews`, so asking one never affects another's
thread.

If the first argument is not a reviewer, the runtime uses the only reviewer other than the agent it runs inside, and
otherwise fails and asks you to name one. It recognizes that agent from the environment, and if it cannot tell, it
treats every reviewer as available. `agy` is never the default: it runs only when named, and only after the user opts
in by setting `CROSS_REVIEW_AGY_AUTH=login`, because Google's FAQ and terms conflict on using a consumer login this way.
Until then the runtime refuses and says so; the choice is the user's, so do not set it for them.

A review by the agent it runs inside is refused, because that agent's own review command already does that job; pass
`--allow-self` to run one anyway, as a fresh conversation. A reviewer cannot start another review: the runtime marks
each reviewer's environment with `CROSS_REVIEW_DEPTH` and refuses, with no override. The mark can only be lost on a
Codex reviewer whose `shell_environment_policy.include_only` leaves it out. A review is also refused when Codex's
sandbox has cut off the network, since a reviewer needs it to reach its API. None of this affects `status`, `result`,
`cite`, `cancel`, or `reset`.

The runtime removes the host agent's session variables and tokens from the reviewer's environment. Your own
configuration, such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and API keys, still reaches it.

## Review scopes

```text
cross-review.mjs <reviewer>                               working tree, current repository
cross-review.mjs <reviewer> working                       staged, unstaged, and untracked work
cross-review.mjs <reviewer> branch [base]                 merge-base-to-HEAD branch change
cross-review.mjs <reviewer> commit [ref]                  one commit, default HEAD
cross-review.mjs <reviewer> range <from>..<to>            explicit two-dot range
cross-review.mjs <reviewer> repo                          whole repository
cross-review.mjs <reviewer> again                         previous scope in the active session
cross-review.mjs <reviewer> new [scope]                   new session, then review
cross-review.mjs <reviewer> reset                         forget active session; retain artifacts
```

Every review result prints its plugin session ID, which is what `--resume-session` takes, and the reviewer's own
conversation ID, which opens that conversation interactively: `codex resume <thread-id>` or
`claude --resume <session-id>`.

To resume an exact active session with a new scope after the branch identity changes, including when an exact-commit
review worktree advances to a descendant, pass:

```text
cross-review.mjs <reviewer> --resume-session <session-id> range <prior-head>..<current-head> [-- focus]
```

The selected session must remain active in the same working-tree root and use a clean checkout with a committed
scope (`branch`, `commit`, `range`, or `repo`); working scope and `--include-working` are rejected. It must have a
completed review whose stored scope and HEAD identify the same recorded commit tip, keep that tip as an ancestor of
the current HEAD, and target a new scope whose committed tip equals that HEAD. No other active session may already
own the destination checkout identity. A successful resume follows the current checkout identity. A sibling linked
worktree has separate session storage. Pass the ID again after each
detached HEAD change, and leave that working tree untouched until the resumed review finishes. The runtime samples
its named-or-detached identity, HEAD, and cleanliness before invoking the reviewer and before applying the result;
these samples apply only to explicit `--resume-session` reviews, and cannot detect a transient change restored
between them. Background execution may overlap work in another checkout.

Once a reviewer process starts, any error, timeout, cancellation, worker death, checkout mismatch, malformed result,
or persistence failure that prevents its result from being applied retires the plugin session at its last accepted
scope and HEAD. Cancellation ends continuity. `again` then reports why it cannot resume, while an ordinary review
starts a new isolated session and reports the transition. Review the unapplied delta; optional continuity does not
require a broader replay. `again` normally repeats the selected session's previous scope definition; use an explicit
range for a focused delta. Use `new` when history, review scope, or intended context should not continue.

Put custom focus or follow-up feedback after `--`:

```text
cross-review.mjs codex branch main -- Focus on authorization and tenant isolation
cross-review.mjs claude again -- The callback API is intentionally retained for compatibility
```

The runtime also accepts trailing focus text without `--` when unambiguous.

To add a file's text to the focus, such as a repository's review checklist, pass `--focus-file <path>`:

```text
cross-review.mjs codex range main..HEAD --focus-file docs/review-focus.md -- Also check the importer
```

The runtime reads the file on the host when it prepares the review. A relative path resolves against the current
directory, not `--dir`, and the file may live outside the reviewed repository. A missing or unreadable file fails
before anything is recorded. The reviewer sees the file's text first, labeled with its path, then the `--` text.
The session ledger records the file's path and SHA-256, not its text, and decisions are parsed only from the `--`
text, so a focus file cannot record one. Pass `--focus-file` again on each round that should include it.

## Audits

For a line-by-line audit, such as of generated code, pass a rubric file, a checklist file, or both:

```text
cross-review.mjs codex new repo --background --rubric-file audit/rubric.md --checklist-file audit/checklist.txt
```

`--rubric-file` replaces the built-in rules for what counts as a finding and how severe it is, and with them the
built-in exclusions, such as linter nits and the rule that a change scope reports only what the change introduced;
the rubric restates any it still wants and rates severity as `critical`, `high`, `medium`, and `low`.

`--checklist-file` lists one item per line as `<id> <description>`; blank lines and lines starting with `#` are
skipped. The reviewer returns exactly one verdict per item, with a one-line note: `keep`, `finding`, `confirm`,
`refute`, or `not_applicable`. Each finding names the checklist items it answers, and the runtime derives each
verdict's finding ids from those links. A checklist without a rubric keeps the built-in rubric, for example to
confirm or refute another reviewer's findings listed by id. When a checklist lists another reviewer's findings, prefix
their ids, for example `codex:F-1a2b3c`, so they are not confused with this session's own ids. A prose review
checklist is still focus text for `--focus-file`.

A round with either file also reviews generated files in the resolved scope, which an ordinary review skips. The
artifact directories, `.git`, dependency and vendor trees, and credential files stay off limits, and the reviewer
still writes only to scratch and never commits or pushes.

The runtime reads both files on the host when it prepares the review. A relative path resolves against the current
directory, not `--dir`. A missing or unreadable file, or a checklist with a duplicate id, a line without a
description, or no items, fails before anything is recorded. The session ledger records each file's path and SHA-256,
not its text. Neither file carries over: pass it again on each round that should use it. Start an audit with `new` to
keep it separate from earlier reviews, and start the next ordinary review with `new` too, since a plain round resumes
the audit's conversation and inherits its findings.

The runtime checks the verdicts against the checklist and never fills one in. A verdict or link that copies an item's
listed line instead of its bare id, such as `` `id` `` or `id: description`, counts for that id, and the `Coverage:`
line says how many labels were normalized; a label that fits two ids, such as `a—b: x` when both `a` and `a—b` are
listed, counts for the longer and is reported in the warning. Items without a verdict, verdicts or links naming
unlisted items, an item answered twice, a `finding` verdict no finding links to, and a finding linked to an item
marked `keep` or `not_applicable` become one `Warning:` line and a warning in the artifact. `status` and `result`
print a `Coverage:` line with the count of each verdict and a `Verdicts:` line naming
`<task directory>/<seq>-<scope>.verdicts.json`, which each completed round writes with the checklist, the coverage,
and the verdicts in checklist order; a failed or cancelled round leaves none and prints no `Coverage:` line. The
rendered result ends with a checklist coverage section, and `cite` prints the coverage before the findings. Verdicts
never change a finding's disposition.

## Options

```text
--dir <path>                 target another repository
--focus-file <path>          add a file's text to the review focus; see above
--rubric-file <path>         replace the finding and severity rules for this round; see Audits
--checklist-file <path>      require one verdict per item listed in this file; see Audits
--resume-session <id>        resume this repository's prior active session
--model <model>              explicitly select and persist a model for this session
--effort <level>             codex: minimal, low, medium, high, xhigh, max, or ultra; claude: low, medium, high,
                             xhigh, or max; default max. agy: low, medium, or high; default medium, and ignored
                             when --model names a model, since its model names carry the level
--capability <mode>          full (default), workspace, or read-only; see below. agy: read-only only
--include-working            add local changes to branch, commit, or range scope
--background                 start a persistent, detached background job
--wait                       run a review in the foreground; with status or result, block until the job ends
--wait-minutes <number>      longest a status or result --wait call blocks; default 5
--timeout-minutes <number>   hard timeout for the reviewer process; default none
--allow-self                 let the agent the runtime runs inside review too; see Reviewers
--max-budget-usd <amount>    claude only: pass an API billing cap to Claude Code
```

## Reviewer capabilities

`full` gives the reviewer everything its agent can normally do, including your MCP servers, hooks, and settings; for
Claude, that includes the project settings of the reviewed repository.

`workspace` differs by reviewer. Codex keeps the `workspace-write` sandbox with network access: the checkout, `/tmp`,
and the scratch directory are writable, and `.git` is protected so it cannot commit, stash, or move refs. For Claude
it behaves like `full`, because Claude Code has no OS sandbox in headless mode.

`read-only` uses Codex's read-only sandbox. For Claude it limits built-in tools to Read, Glob, and Grep, denies
anything without a pre-existing permission rule (your MCP tools follow those rules), and loads only your user
settings, so the reviewed repository's own `.claude/settings.json` hooks do not run.

`agy` offers only `read-only`, because a repository's hooks and MCP commands run with no trust prompt wherever `agy`
starts, even under its sandbox. It starts in an empty directory outside the repository, under `--sandbox`, with write
tools denied and file reads granted for the repository and the Git configuration that `git` needs. Since `agy` also
reads `.agents/` from each parent up to the repository root, the runtime refuses to start when the temporary directory
is inside any Git repository; point `TMPDIR` elsewhere. It can read files and run read-only `git`; a write from a
command fails. It cannot run the repository's tests. A turn that stops to ask for approval, or that returns no
structured review, fails rather than counting as an empty review.

Every session has a scratch directory at `<task directory>/scratch/`, ignored by Git and named in the prompt as the
only place inside the repository the reviewer may create files; it persists across rounds. The prompt tells the
reviewer to leave the checkout as found and never commit or push. After the review, on success or failure, the
runtime compares HEAD, refs, the dirty set by content, newly ignored paths, and `.git` config and hooks with what
it saw before; any difference becomes a `Warning:` line naming the paths in the result and a warning section in
the artifact. If HEAD moved, the session keeps the pre-review HEAD as its last reviewed commit. Explicit
`--resume-session` reviews still fail on any change.

## What the reviewer receives

A filtered view of the change: credential-looking file names and untracked files whose content looks like a
private key or access key are omitted, credential-looking values inside committed patches are replaced with
`[redacted]`, and the prompt says which, before the change itself. Committed scopes carry the commit log, the
diff stat, and the SHAs. Up to 256 KB and 40 files are inlined (untracked files up to 512 KB each, 2 MB total); a
larger change is summarized and the patch handed over as `git diff` commands per file when the reviewer can run
git, or as per-file patch files under `<task directory>/context/<job-id>/` when it cannot (Claude in read-only
mode).

## Result format

Findings are sorted by severity then confidence. Each shows its id (`F-` plus six hex characters, assigned by the
runtime and shown back to the reviewer in every later round), severity, title, location, flags such as `pre-existing`, `persisting`, `duplicate id`, or `no location
cited`, then the body, the trigger, quoted evidence, confidence, and recommendation. Results end with numbered next
steps and residual risk. The ids are recorded in the session ledger inside `session.json`. With a checklist,
results end with a checklist coverage section; see Audits.

## Decisions

A decision is your verdict on a finding, written at the start of a sentence or line in the `--` focus text as
`reject F-1a2b3c: reason`, `accept F-...`, `defer F-...`, or `reopen F-...`; a focus file's text is never read for
decisions. A reason runs to the next semicolon or line end, so put each decision on its own line or separate them with
semicolons. A phrase shaped like a decision that the runtime did not record, such as `accept F-...` inside a reason or
after a comma, gets a `Warning:` line naming it, and the review still runs, so repeat the decision next round if you
meant one. The runtime does not read more into the text because a wrong decision is worse than a missed one. It records
it on the finding before the reviewer starts, so it survives a review that fails or a
session that retires, and shows every prior finding with its observation, disposition, and decision to the reviewer
in each later round. A rejected finding can only come back as a reopen proposal with new evidence; reviewer output
never changes a disposition. A decision on an id the session does not know fails before the reviewer runs. When a
retired session is replaced, or the branch history is rewritten under an active session, the new session inherits
the ledger and says so; `new` starts without it. An id printed with a `resembles` flag folds into the earlier
finding before the next round and stays usable as an alias, unless you have already decided on the earlier finding,
in which case both stay separate for you to decide.

## Job controls

```text
cross-review.mjs <reviewer> status [job-id] [--wait] [--dir <path>]
cross-review.mjs <reviewer> result [job-id] [--wait] [--dir <path>]
cross-review.mjs <reviewer> cite [job-id] [--dir <path>]
cross-review.mjs <reviewer> cancel [job-id] [--dir <path>]
```

Job controls look only at the named reviewer's jobs. When no job ID is supplied, operate on the latest applicable job.
With `--wait`, `status` and `result` poll the job until it reaches a terminal status or `--wait-minutes` elapses, then
print it; a still-running job says so, and another `--wait` call keeps waiting.

`cite` prints each finding of a completed job with the lines it cites and three lines of context, read from the
reviewed revision for committed scopes and from the working tree for working, repo, and include-working scopes
(flagged when the tree or HEAD has changed since the review, and noting when the index or the committed version
of the file differs). Without a job ID it picks the latest job for the current checkout. A location it cannot
resolve, or one outside the repository, is marked unverifiable; credential-looking paths are not shown and
credential-looking values on printed lines are redacted. The host uses it to classify findings before relaying
them.

## Important mappings

Put the reviewer first and add `--background` to each review:

- “Review what I have changed” → `working`
- “Review this branch against main” → `branch main`
- “Review the last commit” → `commit HEAD`
- “Review commit abc123” → `commit abc123`
- “Review everything since v1.2” → `range v1.2..HEAD`
- “Review the architecture/codebase” → `repo`
- “Review it again” → `again`
- “Continue session X over only these fixes” → `--resume-session X range PRIOR_HEAD..HEAD`
- “Reject finding F-1a2b3c, it is intentional” → `again -- reject F-1a2b3c: intentional`
- “Use the checklist in docs/review-focus.md” → add `--focus-file docs/review-focus.md`
- “Audit the generated app with rubric R and checklist C” → `new repo --rubric-file R --checklist-file C`
- “Have Claude confirm or refute Codex's findings” → `claude` with `--checklist-file C`, where C lists each finding
  as `codex:F-1a2b3c <claim>`
- “Start over” → `new`
- “Forget that review thread” → `reset`
- “Is the review done?” → `status`, or `result --wait` to block for the result
