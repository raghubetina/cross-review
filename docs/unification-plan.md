# Plan: unify claude-review and codex-review, then improve both

Status: revision 7, 2026-11-05. All six phases are done, and section 10 logs
every review round. Section 11 records what came next: the two plugins became
one in 0.9.0, so the layout and plugin names in the earlier sections are history.

## 1. Goals

1. One repository ships both plugins: claude-review (a Codex plugin that asks
   Claude Code to review) and codex-review (a Claude Code plugin that asks Codex
   to review), with one shared runtime and a thin backend per reviewer. Done.
2. Reviewers get full capabilities by default: run tests, write scratch code,
   install tools, download libraries, drive browsers. The runtime protects the
   reviewed checkout with rules and verification, not by removing tools.
3. Review quality improvements ranked from the comparables study: vendor
   rubrics in the prompt, stable finding IDs, an on-disk decisions ledger,
   size-aware context, a host-side double-check step, a wider secret filter,
   delimited untrusted context.
4. The user-facing CLI and the session model stay as they are. Existing
   `tmp/claude_reviews/` and `tmp/codex_reviews/` state is discarded; there
   is no compatibility layer.

Non-goals: stop-gate hooks, auto-review nudges after edits, an MCP bridge, the
Codex app-server native reviewer, multi-model debate protocols.

## 2. Facts the plan relies on

Verified on this machine unless noted.

- After a mechanical Claude/Codex rename, the two runtimes differ in 228 of
  about 1,600 lines. The differences are the invocation arguments, output
  parsing, conversation identity, the version check, and prose.
- Both hosts copy an installed plugin out of the source repo. Claude Code
  installs from the marketplace `source` subdirectory into
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`; Codex installs
  into `~/.codex/plugins/cache`. Shared code outside a plugin directory is not
  present after install, so each plugin directory must be self-contained.
- Codex CLI 0.153.4: `codex exec -` and `codex exec resume <thread> -` both
  accept `--json`, `-o`, `--output-schema`, `-m`, `-c key=value`, and
  `--skip-git-repo-check`. `-s` and `--add-dir` exist only on `exec`, so
  sandbox and writable roots go through `-c sandbox_mode=...`,
  `-c sandbox_workspace_write.network_access=true`, and
  `-c 'sandbox_workspace_write.writable_roots=[...]'`. Both overrides were
  exercised end to end: the reviewer wrote a file into the extra root.
  Reasoning effort accepts minimal, low, medium, high, xhigh, max, ultra.
- On Codex 0.153.4, `-c mcp_servers={}` does not disable MCP servers, because
  `-c` merges tables. Per-server `-c mcp_servers.<name>.enabled=false` works
  for bare names only; a profile-v2 layer file with quoted table keys works
  for any name. The plan no longer disables MCP servers; this is recorded so
  the no-op is not reintroduced.
- Claude Code 2.1.273: `--permission-mode` accepts acceptEdits, auto,
  bypassPermissions, manual, and more; `--dangerously-skip-permissions`,
  `--allowedTools`, `--tools`, `--setting-sources`, `--strict-mcp-config`
  exist. `claude -p --session-id` and `--resume` are what claude-review uses
  today. `claude -p --permission-mode bypassPermissions` runs Bash with no
  extra flag.
- Codex's native review rubric is at
  codex-rs/prompts/templates/review/rubric.md in openai/codex, Apache-2.0.
- Claude Code's Bash tool caps one call at 10 minutes; Codex's shell tool has
  its own timeout. Detached background workers survive both.

## 3. Repository layout

Rename the existing `raghubetina/codex-review` repository to `cross-review`
so GitHub redirects keep the current install path alive until both hosts are
re-pointed. Import claude-review by copying its files in one commit whose
message cites the source repository and commit. Once the Codex marketplace
path from the new repo is verified, add a README pointer to `claude-review`
and archive it read-only; its six original commits stay there as history.

```text
cross-review/
  .claude-plugin/marketplace.json        Claude Code marketplace -> plugins/codex-review
  .agents/plugins/marketplace.json       Codex marketplace       -> plugins/claude-review
  src/
    runtime.mjs                          shared core (CLI, git, sessions, jobs, context, prompt, render)
    backends/claude.mjs                  invocation args, output parsing, version check
    backends/codex.mjs
  plugins/
    codex-review/.claude-plugin/plugin.json
    codex-review/skills/codex-review/{SKILL.md, references/interface.md, scripts/}
    claude-review/.codex-plugin/plugin.json
    claude-review/skills/claude-review/{SKILL.md, references/interface.md, agents/openai.yaml, scripts/}
  scripts/build.mjs                      copies src/ into each plugin's scripts/ directory
  tests/
    fixtures/fake-claude.mjs, fake-codex.mjs
    runtime.test.mjs                     parametrized over both backends
    build.test.mjs                       asserts the copied runtime matches src/
```

Each plugin's `scripts/` holds `<name>.mjs`, a five-line entry that imports the
copied `runtime.mjs` and calls `main({ backend: "codex" })`, plus the copied
`runtime.mjs` and `backends/`. No bundler and no dependencies; the build is a
copy, and a test fails when the copies drift. The copies are committed so a
plugin install needs no build step.

## 4. Backend contract

As shipped in `src/backends/*.mjs`, validated by `validateBackend()` when the
runtime starts:

```js
{
  name: "codex", reviewerLabel: "Codex", artifactDirectory: "tmp/codex_reviews",
  binaryEnv: "CODEX_REVIEW_CODEX_BIN", defaultBinary: "codex",
  versionLabel: "Codex CLI", minVersion: [0, 136, 0], installHint: "...",
  effortLevels: [...], defaultEffort: "max",
  conversationStrategy: "assigned" | "chosen",
  conversationLabel: "Codex thread ID", resumeHint: (id) => `codex resume ${id}`,
  extraOptions: { "--max-budget-usd": { key: "max_budget_usd", usage: "..." } },
  usesLastMessageFile: true,
  prompt: { full: { tools, repoScope, truncation }, workspace: {...}, "read-only": {...} },
  buildArgs({ job, session, schema, schemaPath, lastMessagePath, capability }) -> argv,
  earlyConversationId(line) -> id | null,        // optional
  // Optional, for a reviewer that needs them. Section 11 has why agy does:
  capabilities: ["read-only"],                   // what it offers; default all three
  explicitOnly: true,                            // never the default reviewer
  usageNote: "...",                              // a sentence for --help
  refusal(env) -> message | null,                // refuse to start a review
  spawnOptions({ job, env }) -> { cwd, env, cleanup },
  isTerminalEvent(line) -> boolean,              // stop resultGraceMs after this event
  resultGraceMs: 30_000,
  parseOutput({ stdout, lastMessage }) -> { candidate, rawResult, conversationId, usage, models },
  artifactLines({ job, session, parsedOutput, invocation }) -> string[]
}
```

- `conversationStrategy` captures the one structural difference. `chosen`
  (Claude): the runtime generates a separate `conversation_id` UUID when it
  creates the session and passes it as `--session-id`, so the plugin session
  id never doubles as a reviewer handle. `assigned` (Codex): the id arrives in
  the first `thread.started` event and is recorded on the job immediately and
  on the session when the result is applied.
- The runtime, not the backend, validates the structured result, and will own
  finding ids, sorting, and rendering (phase 3).
- Extra options are numeric and positive for now; a backend that needs another
  kind extends the shared parser rather than working around it.
- The prompt is shared. Backend text differs only in the three `prompt.*`
  sentences per capability; the conduct paragraph, including the scratch
  directory, is runtime text.

## 5. Reviewer capabilities

New option `--capability <full|workspace|read-only>`, default `full`,
recorded per job and shown in the artifact header.

| Mode | Codex backend | Claude backend |
| --- | --- | --- |
| full | `sandbox_mode="danger-full-access"`, `approval_policy="never"` | `--permission-mode bypassPermissions`, all tools |
| workspace | `sandbox_mode="workspace-write"`, `network_access=true`; the checkout, `/tmp`, and scratch writable, `.git` protected | same as full (Claude Code has no OS sandbox in `-p` mode) |
| read-only | `sandbox_mode="read-only"`, `approval_policy="never"` | `--tools Read,Glob,Grep --permission-mode dontAsk --setting-sources user`, so a reviewed repository's own hooks cannot run |

The reviewer is the same agent the user already trusts to write code, so it
inherits the user's full Codex or Claude configuration in every mode: MCP
servers (a Playwright server, a Render logs server, a docs server), hooks,
settings, and skills. There is no MCP switch. For the Claude backend this
means dropping `--strict-mcp-config` and `--setting-sources user` so the
review runs like a normal Claude Code session. The current codex-review passed
a no-op `mcp_servers={}` and documented MCP as disabled; that was removed and
the docs corrected on 2026-09-16.

Guardrails that apply in every mode:

1. Scratch directory. Each session gets `<artifact-root>/<task>/scratch/`,
   already ignored through `info/exclude`. The prompt names it as the only
   place inside the repository the reviewer may create files, and says scratch
   work persists across rounds so a test harness from round one is reusable.
2. Checkout rules in the prompt. Leave the reviewed checkout as found: no
   edits to tracked files, no new files outside scratch, no git commands that
   change refs, the index, the stash, or the working tree, no commits, no
   pushes, and revert any experiment before finishing.
3. Runtime verification. Before invoking the reviewer, snapshot HEAD, refs,
   the dirty set by content, the list of ignored paths, and `.git` config and
   hooks. Afterwards, on success or failure, attach a warning naming every
   difference to the job, the artifact, and the rendered output. A HEAD move
   is a warning rather than a failure because committing while a background
   review runs has always been allowed and the runtime cannot tell the user's
   commit from the reviewer's; the session records the pre-review HEAD as its
   last reviewed commit so a stray commit can be undone without losing
   continuity. Ignored paths that already existed are not compared. Explicit
   `--resume-session` reviews keep failing on any change, as today.
4. Documented risk. In `full` mode the reviewer runs with the user's own
   privileges and network, while reading untrusted repository content.
   README and SKILL.md say so and recommend `--capability read-only` for
   repositories the user does not trust.

Open question: whether Claude's `full` also needs `--setting-sources user` and
which of the user's hooks fire inside a headless review.

## 6. Review quality improvements

### 6.1 Prompt rubric (both, small). Done 2026-09-16.

- Embed the eight "is it a bug" tests, the comment rules, and the
  pre-existing-versus-introduced rule from Codex's rubric, with Apache-2.0
  attribution in a NOTICE file. Add the false-positive list paraphrased from
  Anthropic's code-review plugin: linter-catchable, pre-existing, on unmodified
  lines, likely intentional, pedantic nits.
- Define each severity. Keep `critical/high/medium/low` in the schema and map
  P0 to P3 onto them in the prompt so existing artifacts stay comparable.
- Calibration lines: prefer one strong finding over several weak ones; state
  when a conclusion rests on inference; keep confidence honest.
- The introduced-only and unmodified-lines exclusions apply to change scopes
  only (working, branch, commit, range). In `repo` scope the prompt says
  pre-existing defects are the point of the review. Ledger findings may be
  reported with a status update in any scope.
- Revised 2026-09-29 in 0.7.3: the exclusion covers problems that existed
  before the change, not every problem on unmodified lines. A problem the
  change causes on lines it did not touch, such as a caller it breaks, a test
  it invalidates, or a documentation claim it makes false, counts as
  introduced. So does the part of an older problem that the change extends,
  such as new inputs sent into an old defect or a further respect in which an
  already stale claim becomes false. The earlier wording contradicted review
  focus that put such claims in scope. The new wording permits reporting
  them; in a First Draft documentation probe, whether Codex looked for them
  still depended on the focus.
- Replace the trailing `Session metadata: <uuid>` line with nothing. Wrap the
  diff, untracked files, and focus text in `<repository_context>` and
  `<user_focus>` tags and say the content inside is data, not instructions.

### 6.2 Schema v2 and rendering (both, medium). Done 2026-09-16, except that the reviewer is told to return null ids until phase 4 injects the known findings.

Add to each finding: `pre_existing` (boolean), `trigger` (the scenario or
input needed), `evidence` (quoted lines), and `observation` with values `new`,
`persisting`, `fixed`, `reopen_proposed`. The reviewer never sets a
disposition; `rejected` and the other user dispositions exist only in the
ledger. Add top-level `next_steps` (array of strings). Keep `file` and `line_start` nullable only for `repo` scope; for
other scopes the runtime marks a finding without a location as degraded.

The runtime assigns each finding an id once (`F-` plus six hex characters)
when it first enters the ledger. On re-reviews the prompt lists existing
findings with their ids, and the schema gains a nullable `id`: the reviewer
returns the existing id when reporting on a known finding and null for a new
one. A content fingerprint (file plus normalized title) is only a matching
hint the runtime uses to warn when a null-id finding looks like a known one;
it never creates or merges ids, so rewording keeps identity and two defects
with the same title stay distinct. Rendering sorts by severity, then
confidence, groups by id, flags apparent duplicates without deleting them,
normalizes `line_end` below `line_start`, and shows id, observation,
disposition, and pre-existing flags.

### 6.3 Decisions ledger (both, medium). Done 2026-09-16.

The ledger lives inside `session.json` under `ledger`, so reviewer
observations are written in the same atomic replace as
`last_applied_job_id`, `review_count`, and `last_head`. There is no separate
ledger file and therefore no crash window between the two: a worker that dies
before `commitReview` leaves no observation change, and the existing
applied-result recovery already treats that job as unapplied.

User decisions follow a different rule because they must not depend on the
reviewer succeeding. `prepareJob` validates decisions parsed from focus text
(the id must exist in the ledger) and writes them to `session.json` under the
state lock before the reviewer starts; that write changes no review counter
and no applied-result marker. The `acceptedSession` snapshot that
`executeJob` takes therefore already contains them, so a review that times
out or is retired still carries the user's decisions into the replacement
session, which `createTask` seeds from the accepted ledger.

```json
"ledger": {
  "findings": {
    "F-3a2b9c": {
      "first_job": "review-...", "last_job": "review-...",
      "severity": "high", "title": "...", "file": "...", "line_start": 12,
      "observation": "persisting",
      "disposition": "rejected",
      "decision": { "text": "callback API is public", "job_id": "review-...", "at": "..." }
    }
  },
  "notes": [ { "text": "...", "job_id": "...", "at": "..." } ]
}
```

- `observation` is the reviewer's latest report (`new`, `persisting`, `fixed`,
  `reopen_proposed`) and is overwritten by every applied review that mentions
  the id. Findings the reviewer omits keep their previous observation; the
  prompt asks for an explicit `fixed`.
- `disposition` belongs to the user (`open`, `accepted`, `rejected`,
  `deferred`) and changes only through focus text: `again -- reject F-3a2b9c:
  public API`, `accept F-...`, `defer F-...`, `reopen F-...`. Reviewer output
  never changes a disposition.
- A rejected finding the reviewer reports again must carry
  `observation: reopen_proposed`; the prompt allows that only when new
  evidence materially changes the finding, and rendering shows it as a
  proposal, not a finding. The user reopens it with `reopen F-...` or leaves
  it rejected.
- Other focus text is stored as a session note.
- Every re-review prompt gets a compact "Prior findings and decisions" table
  from the ledger, whether or not the reviewer's conversation resumed. This is
  what makes continuity survive retirement. Before injecting, entries recorded
  by rounds that could not reference ids (phase 3 sessions) are deduplicated
  by file and normalized title so one defect is shown once.
- `again` after retirement therefore works: new conversation, inherited ledger,
  and the output says so.

### 6.4 Size-aware context (both, small). Done 2026-09-16.

Measure the diff first. Inline it when it is at most 256 KB and at most 40
files. Otherwise send the changed-file list, `git log --oneline` for the
range, `git diff --stat`, and the base and merge-base SHAs, plus a
capability-aware way to get the patch:

- When the reviewer can run git (Codex in every mode, Claude in `full`), an
  instruction to run `git diff <range> -- <path>` per file.
- When it cannot (Claude `read-only`), the runtime writes per-file patches to
  `<task>/context/<job-id>/NNN-<path>.patch` plus the whole diff, and lists
  their absolute paths for the Read tool. Root commits and working-scope
  untracked files go through the same writer.

Filtering happens once, in a shared collection stage that runs before either
transport: filename rules, content sniffing, and binary detection produce one
filtered patch set, and both inline delivery and the patch-file writer consume
it. A test feeds the same sensitive inputs through both routes and asserts
identical skip lists, so a private key in an untracked file is omitted below
and above the inline threshold alike.

Always include log and stat for branch, range, and commit scopes. Keep the
8 MB cut only as a last resort for untracked content and add a 2 MB total cap
on inlined untracked files, listing what was skipped.

### 6.5 Secret filter (both, small). Done 2026-09-16.

Extend `likelySecretPath` with `.netrc`, `.npmrc`, `.pypirc`, `*.tfvars`,
`id_ed25519*`, `id_ecdsa*`, `*.jks`, `*.keystore`, `.htpasswd`,
`*.kdbx`. Sniff inlined untracked content for `-----BEGIN ... PRIVATE KEY-----`
and `AKIA[0-9A-Z]{16}` and replace the file body with a skip note. Tests cover
each pattern.

### 6.6 Host double-check step (both, small). Done 2026-09-17, with a `cite` command in the runtime that prints the cited lines from the reviewed revision so the host does not reconstruct them by hand.

SKILL.md for both hosts gains a step after results arrive: read only the lines
each finding cites, classify it as agree, disagree with evidence, nuance,
false positive, or uncited, and report the classification with the findings.
Citations are resolved against the reviewed revision, not the current
filesystem: `git show <scope tip>:<path>` for committed scopes, and the
working tree for working scope only after the recorded fingerprint still
matches. A location that cannot be resolved is unverifiable, not a false
positive; a false positive is a location that exists at the reviewed revision
but does not contain the claimed code. The host reads enough surrounding
lines to judge the claim and must not edit code.

### 6.7 Carried over from codex-review (done in codex-review)

`status --wait` and `result --wait` with `--wait-minutes` (default 5), the
five-second wait windows in the timing-sensitive tests, and the Thread ID line
in output. All move into the shared core, so claude-review gets them.

### 6.8 Record the conversation id early (both, small)

Backends declare how the conversation id becomes known. `chosen` (Claude):
the runtime picks the session id and records it on the job in `prepareJob`,
which is also where a resumed job of either backend copies the session's
existing id. `assigned` (Codex): the backend exposes an incremental event
hook; the runtime feeds it stdout as it arrives and, on the first
`thread.started` event, writes `thread_id` to the job file only, never to the
session, so early metadata can never count as an applied result. Claude's
`--output-format json` emits one result at exit and has no early event, which
is why the hook is Codex-only. Either way `status` shows the id while the
review runs, and a review killed mid-flight leaves a handle that `codex
resume` or `claude --resume` can open. (Done in codex-review for the Codex
side on 2026-09-16.)

## 7. Compatibility

None is kept. `STATE_VERSION` becomes 2 and the runtime ignores session and
job files with any other version, printing one line that tells the user to
delete the old `tmp/claude_reviews/` or `tmp/codex_reviews/` directory. Job
files gain `capability`, `checkout_warning`, and `conversation_id`. New flags are
`--capability` and `--wait-minutes`; `--max-budget-usd` stays on the Claude
backend.

## 8. Sequencing

Each phase ends with green tests for both backends, one squashed commit, a
Codex review of the diff through codex-review, and a Claude review through
claude-review.

- Phase 0, repo. Done 2026-09-16: renamed to cross-review, claude-review
  imported in one cited commit, both marketplaces served from one repo, both
  installs verified from GitHub, claude-review archived with a pointer.
- Phase 1, shared core. Done 2026-09-16: `src/runtime.mjs` plus the two
  backends, copy step with a drift test, one suite parametrized over both
  backends, reviewed by both reviewers (section 10).
- Phase 2, capabilities. Done 2026-09-16: modes, scratch directory, checkout
  rules, HEAD and tree verification as warnings, MCP and settings inheritance,
  docs, live runs in `full` and `workspace` against both CLIs.
- Phase 3, rubric and schema v2. Done 2026-09-16: prompt rubric with
  attribution in NOTICE, schema v2, runtime-assigned ids recorded in a session
  ledger of observations, severity-sorted renderer with next steps.
- Phase 4, ledger. Done 2026-09-16: decision syntax parsed from focus text
  and written before the reviewer runs, prior findings and decisions injected
  into every later prompt, observations recorded without touching
  dispositions, ledger inherited after retirement, id-less entries
  consolidated by file and title.
- Phase 5, context and secrets. Done 2026-09-16: one filtered patch set
  feeding inline, git-instruction, and patch-file delivery; commit log and
  stat for committed scopes; wider name filter and content sniffing; total
  cap on inlined untracked content.
- Phase 6, host double-check and docs. Done 2026-09-17: `cite` command plus
  the classification step in both skills.

## 9. Decisions

Decided by the author on 2026-09-16:

- Reviewers get `full` capability by default and inherit MCP servers, hooks,
  settings, and skills in every mode; the Claude backend runs like a normal
  Claude Code session.
- No compatibility with version 1 state.
- Claude's `conversation_id` is a separate UUID from the plugin session id.

- Repository name: `cross-review`; the plugins inside keep their names.
  Superseded by section 11.
- All three capability modes stay: `full` (default), `workspace`,
  `read-only`.
- Severity vocabulary stays `critical/high/medium/low`, with Codex's P0 to
  P3 definitions mapped onto it in the prompt.
- claude-review is imported by copying its files in one commit that cites
  the source repository and commit; no subtree import.
- After the move, claude-review gets a README pointer and is archived
  read-only.

## 10. Review log

Revision 1 was reviewed by Codex (max effort) through codex-review itself, job
`review-mu3ytci3-8bb89e`, thread `01a0a9c9-956d-7043-b00c-f6278d76a55d`.
Findings and how revision 2 answers them:

1. High. `mcp_servers={}` does not disable MCP servers on Codex 0.153.4, and
   inherited MCP tools escape both hosts' read-only controls. The no-op was
   removed from the current plugin; the author then decided that reviewers
   inherit MCP servers in every mode, so section 5 no longer disables them.
2. High. Defaulting `conversation_id` to `session_id` would break legacy Codex
   sessions that store `thread_id`. Moot: the author dropped compatibility
   with version 1 state, and section 7 now says so.
3. Medium. Hashing file plus title is not a stable identity. Section 6.2 now
   assigns ids once and has the reviewer reference them.
4. Medium. A separate ledger file has a crash window against the applied
   result marker. Section 6.3 now stores the ledger inside `session.json`.
5. Medium. Model statuses would overwrite user decisions. Section 6.3 now
   separates `observation` from `disposition` with explicit transitions.
6. Medium. The large-diff fallback assumed git access that Claude read-only
   mode lacks. Section 6.4 is now capability-aware and writes patch files.
7. Medium. Introduced-only rules would suppress `repo` scope findings.
   Section 6.1 scopes the exclusions.
8. Medium. The double-check step resolved citations against the current
   filesystem. Section 6.6 resolves them against the reviewed revision.

The Phase 2 commit was reviewed by both plugins on their resumed sessions.
Codex (job `review-mu48s46v-e34497`) reproduced two gaps: verification ran
only on the success path, and the snapshot relied on Git-quoted paths so an
overwrite of an already-dirty non-ASCII file went unnoticed. Claude (job
`review-mu48s63t-0c87ff`) verified with probes that dropping
`--setting-sources user` let a reviewed repository's `.claude/settings.json`
hooks run even in read-only mode, that `workspace-write` already makes the
whole checkout writable so the scratch-only wording was wrong, that recording
the moved HEAD as last reviewed severed continuity once the stray commit was
undone, that mtime fingerprints misreported identical rewrites, that the
comparison ignored refs, ignored paths, and `.git` internals, and that section
4 had drifted. All applied in the follow-up commit.

The Phase 3 commit was the first review either plugin ran under the new
prompt and schema, and the rendered results came back with ids, triggers,
quoted evidence, and next steps as designed. Claude (job
`review-mu4brmw6-2f63c9`) found that the injection guard declared the
user's own focus untrusted while the next line said to weight it heavily,
that rules 1 and 4 excluded exactly the persisting and fixed findings a
resumed round must report, that a quoted markdown fence inside evidence
closed the rendered block early, that a file-only citation was flagged as
"no location cited", and that the docs promised session-stable ids before
phase 4 can deliver them; it also noted that rule 3 could suppress security
findings in lax codebases. Codex (job `review-mu4brkmz-73a12c`) reproduced
the fence collision independently. All applied in the follow-up commit,
including a security exception in rule 3, a resumed-round carve-out, and
neutralizing a literal closing tag inside repository content.

The Phase 4 range was reviewed by both plugins, each now reading its own
prior findings and ids in the prompt; both reported the section clear and
the id and observation rules workable, and Claude closed its five Phase 3
findings by id as fixed. Claude (job `review-mu4i9wry-597af4`) found that a
history rewrite deactivated a session without passing its ledger on, that
consolidation deleted the very id the previous result had printed so a
decision on it failed, that sessions written before the ledger existed
crashed on focus text, that fixed findings were re-requested forever, and
that both interface files still said ids were "still to come". Codex (job
`review-mu4i9unc-a826a8`) reproduced the consolidation and initialization
problems independently, showed that two distinct defects sharing a title
were merged, and found that a failed explicit resume onto a new checkout
identity left the retired session unfindable from that identity. All
applied: consolidation now folds only entries the runtime itself flagged as
resembling another and keeps the folded id as an alias; a rewritten branch
and a failed explicit resume both hand their ledger to the replacement; the
prompt lists fixed findings separately and no longer asks for them again.

The Phase 5 commit arrived inline for both reviewers (16 files, 86 KB), so
each exercised the git and patch-file routes on synthetic 45-file commits
instead. Claude (job `review-mu4y4c70-c9f3db`) found that the git route
listed a content-omitted file on its fetch list while telling the reviewer
not to open it, that dropping a whole patch for one credential-shaped string
had hidden this commit's own test files from the reviewer, that untracked
bytes counted toward the inline threshold so the documented untracked caps
could never apply, that the do-not-open rule lived only inside the data
block, and that a diff over the 64 MB buffer left the patch-file route
empty. Codex (job `review-mu4y49nv-c7dfec`) found that commit subjects in
the new summary bypassed the content filter, that untracked files skipped
for size were offered for retrieval unscanned, that git's mnemonic prefixes
broke the patch splitter, and that a new finding far from an older one with
the same title was still folded into it and inherited its rejection. All
applied: credential-shaped values inside committed patches are redacted
rather than the patch dropped, the omitted and redacted lists come first
and their rule is stated outside the data block, routing counts patch
bytes only, every untracked file is scanned before it is inlined or listed,
summaries are redacted, diff prefixes are forced, oversized diffs fall back
to per-file collection, and resemblance requires nearby lines.

The Phase 6 commit closed the plan, and `cite` was exercised live on the
reviews themselves: it printed each finding's cited lines from the reviewed
revision as designed. Claude (job `review-mu5ku2l7-cd40ae`) reproduced a
real escape: in working scope `cite` read whatever path a finding named, so
a `..` path or a symlink printed a file outside the repository into the
host's transcript; it also found that repo and include-working scopes were
cited from HEAD while the reviewer had seen the working tree, that an
unstructured or older job read as "no findings", that a range past the end
of the file was silently clamped, and that the skill did not say how to open
a file at the revision. Its pre-1.0 list added decision verbs that only
count at the start of a sentence, a re-read of the session before the
worker saves so a concurrent reset survives, a byte cap on injected notes,
and a live smoke script. Codex (job `review-mu5ku06s-36bc84`) reproduced the
same escape, showed that binary untracked files bypassed scanning yet were
offered for retrieval, that provenance was lost when the index, the working
copy, and the commit differ, that HEAD was missing from the drift check,
that a resembling newcomer could still inherit a decision, and that a
single file whose diff exceeds the buffer vanished silently. All applied:
`cite` confines paths to the repository after resolving symlinks, reads the
working tree for repo and include-working scopes with HEAD in the drift
check, notes when the index or the commit holds a different version, marks
ranges past the file, redacts rather than hides, and distinguishes no
findings from none recorded; consolidation never merges into a decided
entry; binary untracked files are scanned as bytes and never listed for
retrieval; an overflowing single file stays visible on every route.

Revision 2 was reviewed on the same Codex thread (`again`, job
`review-mu3z9uiz-58cdc5`). It confirmed 2, 3, 4, 7, and 8 resolved and raised
five points, answered in revision 3:

1. High. The patch-file route bypassed the untracked-content secret sniff.
   Section 6.4 now filters once before either transport, with a parity test.
2. Medium. User decisions supplied with a failed review were lost with the
   retired session. Section 6.3 now persists decisions at preparation time.
3. Medium. The reviewer `status` enum and the ledger's `reopen_proposed` were
   inconsistent. Section 6.2 now has one `observation` enum; dispositions are
   ledger-only.
4. Medium. Dotted MCP server names break `mcp_servers.<name>.enabled=false`
   overrides. Moot once MCP servers are inherited everywhere; the working
   mechanism is recorded in section 2 for reference.
5. Medium. Claude has no early event under `--output-format json`. Section
   6.8 now records chosen ids at preparation and limits the event hook to
   Codex.

The Phase 1 commit was reviewed by both plugins on themselves. Codex (job
`review-mu424muv-7ab9d7`) reproduced one regression: the extra-option lookup
used plain property access, so a ref or focus word such as `constructor`
matched an inherited property. Fixed in the next commit with a parametrized
regression test. Claude (job `review-mu424oo8-898815`) found the same bug and
added four low findings, all applied: validate the backend contract at
startup, print the resume hint only once the reviewer has started, cover the
retirement-time conversation id change and `--max-budget-usd` end to end, and
bring this document back in line with the shipped contract.

## 11. One plugin for any host

Decided 2026-11-05 and shipped in 0.9.0. The goal is that any of Claude Code,
Codex, and Antigravity CLI (`agy`) can get a review from either of the other
two. Gemini CLI cannot be the third agent, because since 2026-06-18 it rejects
consumer accounts with `UNSUPPORTED_CLIENT`.

- One plugin with a backend per reviewer. One plugin per reviewer would need 3
  directories and 6 manifests for three agents, and one per host and reviewer 6
  directories. Here a new reviewer is one backend, and a new host one manifest.
- The plugin stays in `plugins/cross-review/`, not at the repository root. Hosts
  copy the whole source, so a root plugin would ship the tests and docs to every
  install, and any README edit would need a version bump.
- `agy` installs from the `/tree/main/plugins/cross-review` URL, because it never
  reads a repository's marketplace file. Its bare repository URL relies on an
  undocumented scan of `plugins/`.
- The reviewer is the first argument. With nothing left to copy, `src/` is gone.
- Self-review is refused by default, with `--allow-self` as the override, because
  each agent has its own review command. A reviewer starting another review is
  refused outright, through `CROSS_REVIEW_DEPTH`, which the Codex backend also sets
  through `shell_environment_policy.set` so that `inherit = "core"` cannot hide it.
  A user's `include_only` filter runs after that and can still remove it; extending
  the list would overwrite the user's, and the guard only catches mistakes. Host
  detection only catches mistakes too, so an undetected host is simply allowed.
- The host's session variables and tokens are removed from a reviewer's
  environment by an explicit list, since a prefix would also remove settings such
  as `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
- `SKILL.md` stays under 8,000 bytes, because Codex 0.166.0's source
  (`codex-rs/ext/skills/src/render.rs`, `MAX_SKILL_PROMPT_BYTES`) cuts an injected
  skill off there, although OpenAI's docs say the full file is read. Nobody has
  seen this happen at runtime yet. The cut would have removed the guardrails on
  untrusted output from both earlier skills.
- An MCP server stays a non-goal. Codex and `agy` default to 60 s and 180 s per
  tool call and reviews have outlasted 30 minutes, so it would only wrap the same
  detached worker in three config formats.

Left for later: an explicit `both` that starts one independent job per other
reviewer, and `status` and `result` that search across reviewers. Job controls
look only at the named reviewer's jobs for now.

### The `agy` reviewer

Shipped in 0.10.0. Owner's decision, 2026-11-05: it uses the owner's Google AI Pro
login, behind an explicit opt-in setting that names the auth mode
(`CROSS_REVIEW_AGY_AUTH=login`), and runs only on demand, with no polling or
automatic triggers. So it is never the default reviewer. The texts behind that decision conflict, and
the README states the conflict for other users:

- The [FAQ](https://antigravity.google/docs/faq): "Wrapping `agy` inside
  third-party coding agents or applications, or automating account rotation, is
  not supported under consumer plans." It recommends a Gemini Enterprise or Google
  AI Studio API key for third-party coding agents.
- The [terms](https://antigravity.google/terms), item 6: "Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for
  suspension or termination of your Antigravity and/or Gemini CLI accounts." Item
  5: "Google employees and contractors may access, view, review and use
  Interactions", with a settings preference to change how that data is used. Check
  it before reviewing private code.
- A [forum reply](https://discuss.ai.google.dev/t/is-invoking-the-official-agy-cli-from-a-local-ai-coding-assistant-allowed-on-an-individual-google-ai-account/185992)
  from a moderator, 2026-09-30, calls spawning the unmodified binary locally for
  your own use "a supported use of the CLI". The asker's follow-up on whether that
  is Google's official reading had no answer as of 2026-11-05. The earliest readable
  copy of the FAQ sentence is from 2026-10-10, so which came first is unknown.

What the backend handles, from runs on `agy` 1.5.1 with tiny prompts:

- A tool needing approval ends the turn with exit 0, `status: SUCCESS`, and an
  empty response, so a result counts only when `status` is `SUCCESS`,
  `denied_actions` is empty, and `structured_output` exists. Read nothing else:
  `response` joins every attempt, invalid ones included.
- A reviewed repository's hooks and MCP commands execute even under `--sandbox`,
  with no trust prompt, so read-only runs start from an empty directory outside the
  repository and grant `read_file(<repo>)`. That needs a backend-supplied spawn cwd
  and env, which the runtime does not offer yet.
- Read-only is `--sandbox` with `toolPermission: proceed-in-sandbox`, `deny
  write_file(*)`, and `read_file` for each global git include. `--mode plan` diverts
  the task, and `--mode auto` was refused on this account.
- Reports say the process can hang after printing its result (17 of 25 runs at
  about 23 KB on 1.4.10), so stop it a grace period after the `result` event, which
  needs a terminal-event hook in the runtime.
- Always pass `--model`, because a resume does not inherit it and `agy` also serves
  Claude and GPT models. The result has no model field, but the `init` event does.
- Effort levels are low, medium, and high; `--effort max` exits 1 despite `--help`.
  The model names carry the level, as in `gemini-4-argon-medium`, so the backend
  sends only `--model`.
- Set `AGY_CLI_DISABLE_AUTO_UPDATE=true`, or `agy` can replace its binary mid-review.
- Omit `-p` and pipe the prompt: stdin takes megabytes, and argv fails at 2 MB.
- There is no `--ephemeral`, and every run stays in the user's conversation history.

Later runs settled the rest:

- Real review turns with prompts of about 25 KB and 256 KB, which is
  `MAX_INLINE_DIFF_BYTES`, succeeded 6 of 6 times in 16 to 48 s and exited within
  0.6 s of the result, since the reported hangs and empty results appear only at
  those sizes. Six runs took Gemini 4 Argon's weekly allowance from 98% to 90%, so
  the default effort is medium.
- With that configuration a turn read a file by absolute path, ran `git -C <repo>`,
  and failed a `touch` in the repository with "Operation not permitted".
- `--conversation <id>` resumes from a different working directory, with the same
  conversation ID, so each run can use a fresh temporary directory.
- `--print-timeout` is unnecessary: a piped prompt with no `-p` runs one turn, and
  its default of 0 waits for the turn to end.
- The [discovery docs](https://antigravity.google/docs/customization-discovery) say
  `agy` reads `.agents/` from each parent of the folder it starts in, up to the
  repository root, and only that folder when it is in no repository. So a `TMPDIR`
  inside any repository would undo the isolation, and the backend refuses one.

It is read-only only, since the hooks finding above means a run inside the
repository could execute that repository's code with no prompt. Offering `full`
would need another answer to that, and a test of `--dangerously-skip-permissions`,
which no run here has tried.
