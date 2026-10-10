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

To add a file's text to the focus, such as a repository's review checklist, pass `--focus-file <path>`:

```text
codex-review.mjs range main..HEAD --focus-file docs/review-focus.md -- Also check the importer
```

The runtime reads the file on the host when it prepares the review. A relative path resolves against the current
directory, not `--dir`, and the file may live outside the reviewed repository. A missing or unreadable file fails
before anything is recorded. The reviewer sees the file's text first, labeled with its path, then the `--` text.
The session ledger records the file's path and SHA-256, not its text, and decisions are parsed only from the `--`
text, so a focus file cannot record one. Pass `--focus-file` again on each round that should include it.

## Audits

For a line-by-line audit, such as of generated code, pass a rubric file, a checklist file, or both:

```text
codex-review.mjs new repo --background --rubric-file audit/rubric.md --checklist-file audit/checklist.txt
```

`--rubric-file` replaces the built-in rules for what counts as a finding and how severe it is, and with them the
built-in exclusions, such as linter nits and the rule that a change scope reports only what the change introduced;
the rubric restates any it still wants and rates severity as `critical`, `high`, `medium`, and `low`.

`--checklist-file` lists one item per line as `<id> <description>`; blank lines and lines starting with `#` are
skipped. The reviewer returns exactly one verdict per item, with a one-line note: `keep`, `finding`, `confirm`,
`refute`, or `not_applicable`. Each finding names the checklist items it answers, and the runtime derives each
verdict's finding ids from those links. A checklist without a rubric keeps the built-in rubric, for example to
confirm or refute another reviewer's findings listed by id.

A round with either file also reviews generated files in the resolved scope, which an ordinary review skips. The
artifact directory, `.git`, dependency and vendor trees, and credential files stay off limits, and the reviewer still
writes only to scratch and never commits or pushes.

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
--model <model>              explicitly select and persist a Codex model for this session
--effort <level>             minimal, low, medium, high, xhigh, max, or ultra; default max
--capability <mode>          full (default), workspace, or read-only; see below
--include-working            add local changes to branch, commit, or range scope
--background                 start a persistent, detached background job
--wait                       run a review in the foreground; with status or result, block until the job ends
--wait-minutes <number>      longest a status or result --wait call blocks; default 5
--timeout-minutes <number>   hard timeout for the Codex process; default none
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
decisions. The runtime records it on the finding before the reviewer starts, so it survives a review that fails or a
session that retires, and shows every prior finding with its observation, disposition, and decision to the reviewer
in each later round. A rejected finding can only come back as a reopen proposal with new evidence; reviewer output
never changes a disposition. A decision on an id the session does not know fails before the reviewer runs. When a
retired session is replaced, or the branch history is rewritten under an active session, the new session inherits
the ledger and says so; `new` starts without it. An id printed with a `resembles` flag folds into the earlier
finding before the next round and stays usable as an alias, unless you have already decided on the earlier finding,
in which case both stay separate for you to decide.

## Job controls

```text
codex-review.mjs status [job-id] [--wait] [--dir <path>]
codex-review.mjs result [job-id] [--wait] [--dir <path>]
codex-review.mjs cite [job-id] [--dir <path>]
codex-review.mjs cancel [job-id] [--dir <path>]
```

When no job ID is supplied, operate on the latest applicable job. With `--wait`, `status` and `result` poll the job
until it reaches a terminal status or `--wait-minutes` elapses, then print it; a still-running job says so, and
another `--wait` call keeps waiting.

`cite` prints each finding of a completed job with the lines it cites and three lines of context, read from the
reviewed revision for committed scopes and from the working tree for working, repo, and include-working scopes
(flagged when the tree or HEAD has changed since the review, and noting when the index or the committed version
of the file differs). Without a job ID it picks the latest job for the current checkout. A location it cannot
resolve, or one outside the repository, is marked unverifiable; credential-looking paths are not shown and
credential-looking values on printed lines are redacted. The host uses it to classify findings before relaying
them.

## Important mappings

- “Review what I have changed” → `working --background`
- “Review this branch against main” → `branch main --background`
- “Review the last commit” → `commit HEAD --background`
- “Review commit abc123” → `commit abc123 --background`
- “Review everything since v1.2” → `range v1.2..HEAD --background`
- “Review the architecture/codebase” → `repo --background`
- “Review it again” → `again --background`
- “Continue session X over only these fixes” → `--resume-session X range PRIOR_HEAD..HEAD --background`
- “Reject finding F-1a2b3c, it is intentional” → `again -- reject F-1a2b3c: intentional`
- “Use the checklist in docs/review-focus.md” → add `--focus-file docs/review-focus.md`
- “Audit the generated app with rubric R and checklist C” → `new repo --background --rubric-file R --checklist-file C`
- “Have Codex confirm or refute Claude's findings” → add `--checklist-file C`, where C lists each finding as
  `claude:F-1a2b3c <claim>`
- “Start over with Codex” → `new`
- “Forget that review thread” → `reset`
- “Is the review done?” → `status`, or `result --wait` to block for the result
