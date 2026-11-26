# Cross Research Runtime Interface

## Threads, rounds, and seats

A thread is one topic. `research` and `brainstorm` each start one. A round puts one request to every seat of the thread
at once, and `again` adds a round. A seat is one researcher with its own persistent conversation: `codex`, `claude`, or
`agy`, or several of one kind. Seats work independently: no seat is shown another's work unless a later round shares
it, and each is told where the others' scratch work and the runtime's records are and to leave them alone, since a
researcher that can read the repository could read them too.

```text
cross-research.mjs research [-- question]                  new thread; every seat researches the question
cross-research.mjs brainstorm [-- problem]                 new thread; every seat lists ideas
cross-research.mjs again [id] [-- follow-up]               next round of a thread
cross-research.mjs status [id] [--wait]                    a round's seats and their state
cross-research.mjs result [id] [--wait] [--round <n>]      every seat's report, side by side
cross-research.mjs check [id] [--round <n>] [--refresh]    test each cited quote against its source
cross-research.mjs cancel [id]                             stop a running round
cross-research.mjs list                                    this repository's threads
cross-research.mjs prune [--older-than <days>]             remove threads idle that long (default 30)
```

An id is a job ID, `research-...`, which names one round, or a thread ID, `T-...`, which names the thread's latest
round. Without an id, a command uses the most recent job in the repository. `--dir <path>` names the repository, and
defaults to the current directory. The text after `--` is the question, the problem, or the follow-up; `research` and
`brainstorm` also accept it as plain words before any `--`. `--question-file <path>` reads it from a file, and text
after `--` is then added to it.

The runtime keeps its records under the Git directory, in `cross-research/` (per worktree, as
`git rev-parse --git-path cross-research` names it). `jobs/` holds one record and one log per round, and
`threads/<thread>/` holds the thread, one directory per round with each seat's prompt, raw event stream, and result, a
`round-<n>.md` report, and `sources/`, the text of every web page `check` fetched. The only state in the checkout is
scratch work: `tmp/cross_research/<thread>/<seat>/`, which the runtime adds to `.git/info/exclude` unless something
already ignores it.

The records decide what a later command runs with the user's privileges: a seat's capability, model, and
conversation, the processes to stop, and the files to read. They are kept where a researcher confined to the
workspace cannot write, and a record is used only if it holds what the runtime wrote: well-formed ids that match the
name it is stored under, this repository, settings the seat's backend allows, and no model or conversation id that a
CLI would read as an option. Any other record is treated as absent.

## Researchers

Without `--with`, every researcher other than the agent the runtime runs inside takes part, because that agent does
its own research in its own conversation. `agy` is left out unless named, and runs only after the user opts in by
setting `CROSS_REVIEW_AGY_AUTH=login`; until then the runtime refuses and says so, and the choice is the user's.

`--with codex,claude` names the seats. A name may repeat, as in `--with codex,codex`, for more seats of one kind,
which become `codex` and `codex-2`. Naming the agent the runtime runs inside is allowed and gives it a fresh
conversation as one more seat. With `again`, `--with` takes seat ids to run only those seats, and researcher names
the thread lacks to add seats; a seat added later is told the thread's question and decisions.

A researcher cannot start research or a review, and a reviewer cannot start research: the runtime marks every
researcher's environment with `CROSS_REVIEW_DEPTH` and refuses. Research is also refused when Codex's sandbox has cut
off the network. The runtime removes the host agent's session variables from each researcher's environment, as
cross-review does.

Each seat's options:

- `--effort <level>` sets every seat, and `--effort codex=high` one kind. Without it each researcher uses its default:
  `max` for Codex and Claude, `medium` for `agy`. A level one kind lacks is an error that names the kind.
- `--model codex=<model>` sets one kind's model. A bare `--model <model>` works when the round has one kind.
- `--capability full|workspace|read-only` is described below. `agy` is always `read-only`.
- `--timeout-minutes <n>` stops each researcher after that long. There is no deadline otherwise.

## Capabilities

A researcher is the same agent the user already trusts to write code, so by default it has that agent's privileges:
the network, the shell, and the MCP servers of the user's own Codex or Claude Code configuration.

| Mode | Codex | Claude | agy |
| --- | --- | --- | --- |
| `full` (default) | no sandbox, live web search | every tool, permissions bypassed | not available |
| `workspace` | `workspace-write` sandbox with network, live web search | same as `full` | not available |
| `read-only` | `read-only` sandbox, live web search, no shell network | `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch` only | web search and page reading, file reads in the repository |

In `full` and `workspace`, a researcher is told to keep everything it clones, downloads, or runs under its seat's
scratch directory, and to leave the checkout as it found it. Nothing compares the checkout afterwards, since the user
usually keeps working while a round runs. In `read-only`, a researcher cannot clone or download, and cites only what
it reads on the web and in the repository. In every mode it is told not to open files named like credentials, such
as `.env` or `*.pem`, unless the question is about them.

Research reads arbitrary web pages, and a page can carry instructions aimed at an agent. In `full`, a researcher that
followed them could do anything the user can. That is the same risk a reviewer with network access carries; pass
`--capability read-only` to narrow it to what the researcher can read.

## Research rounds

Every seat gets the same question and returns:

- `summary`: its answer.
- `claims`: each a single checkable statement, with a `basis` of `source`, `experiment`, or `inference`, a
  `confidence` of `high`, `medium`, or `low`, and `sources`. A source is a web address or a file path, plus one
  passage quoted exactly from it.
- `gaps`: what it could not establish.
- `artifacts`: what it left in its scratch directory, such as a cloned library or a downloaded paper.

The runtime gives every claim an id, `C-` and six hexadecimal digits. `result` prints each seat's report in turn,
then the web pages each seat cited, how many of them no other seat cited, and every page more than one seat cited.

`--lens <text>` gives a seat its own angle on the question; repeat it for more seats, in the order `--with` names
them. Seats without one work the question as asked. On a later round, each `--lens` replaces the lens of the seat at
its position, and `--no-lens` clears every seat's. A seat added on a later round of a brainstorm gets a built-in lens
only when the round names no lens of its own.

## check

`check` reads every source a finished round cited and tests each quote against it, while another round runs too. A web page is fetched once and its text
kept, and the report names the file that holds it, which a later fetch never changes; `--refresh` fetches again. A page whose text cannot be kept is
checked all the same, with a `Warning:` line, and so is a round whose check record cannot be saved. A file is read only if its real path lies in the repository and it is
not named like a credential file, by the same names a researcher is told to leave alone: `.env*`, `*.pem`, `*.key`,
`credentials*`, `secrets*`, and `token*`. It is read through one open descriptor checked to be the file approved, so a
path swapped meanwhile is not followed. A PDF is read with `pdftotext` when that is installed. A GitHub file page is
fetched as the raw file. HTML is parsed by the rules browsers follow, with the copy of parse5 in `scripts/vendor/`,
so an end tag a page leaves out, markup spelled inside a script, and an inline SVG end where they end on screen. A
comment inside a word joins it, the content of a script, a style, a template, or an SVG is hidden, a MathML formula
reads as one object, since no line of text says what it shows, and `xmp`, `textarea`, and `title` show their text as
written. Text whose direction a page sets explicitly is never `found`, since a reader may see it in another order
than it is stored in: inside a directional embedding, override, or isolate, or an inline element that turns the
direction it inherits with `dir` or an inline `direction`, or any element that forces an order as `<bdo>` or an inline
`unicode-bidi` override does, or leaves it to its content, as `dir="auto"` and `<bdi>` do, where that content's first strong character turns
it, as HTML finds that character, and left-to-right where there is none. The `dir` of a whole page sets no such
span, nor does a block's, which is only the base direction its own paragraphs are read in.
Neither is a quote that sets its own direction. A span set by controls ends at its matching pop or with its paragraph, which in
HTML a block, a `<br>`, or a preformatted line break ends, as CSS has it, and a wrapped line does not; one set by an
element ends with the element, and no control inside an element that isolates its content, or inside a form control,
reaches past it. A `<br>` that `hidden` or an inline `display: none` keeps from being laid out ends nothing, and an
inline `white-space` decides whether line breaks show. A `var()` in an inline style is not resolved: a direction or
`unicode-bidi` set through one is unknown, and where an element's `display` is, a quote is `found` only where it holds
whether the element's edges part the words beside them or not. One that needs them parted or joined is `partial`,
and one that needs two such elements laid out differently can read as `missing`.
Text that `hidden`, an inline `display: none`, or a closed `<dialog>` or popover hides is still read and can be
`found`, since pages hide what a reader opens, such as a collapsed section. A hidden block that holds text stands apart from the words around it, as
it does once opened, as does a hidden form control, and a hidden element that shows nothing parts no words. Stylesheets are not read, so text that a page's CSS rules
reorder can still be `found` in the order it is stored in. Where an element that sets direction, or whose `display` comes through `var()`, ends
between a letter and its combining accent, a quote that writes the accented letter whole reads as `missing` rather
than `partial`. Text kept from an earlier version of the check, which may have
read the page differently, is fetched again.

| Status | Meaning |
| --- | --- |
| `found` | The passage is in the source as one run of whole words, whatever the typography, markup, case, and line breaks. Raised and lowered digits must match too, and are told apart, whether written as `10⁶` or `10<sup>6</sup>`; a quote that stops just short of one, as `10` against `10⁶`, is not found. |
| `partial` | Most of it is there as one run, or all of it in pieces, or all of it only inside longer words or once spacing, Markdown markers, or raised digits are ignored, as `106` against `10⁶`. Read the source. |
| `missing` | The source was read and does not contain the passage. |
| `unreachable` | The source could not be fetched: an error, a refusal, a timeout, or a private address. |
| `unreadable` | What came back is not text the check can search. |

`found` says the passage exists, not that it supports the claim. `unreachable` and `unreadable` say nothing about
the claim.

A researcher's output is untrusted, and so is every address in it. The check never fetches an address on this machine
or a private network, where a request could reach a service that trusts local callers: the private, local, and
reserved ranges, the IPv6 forms that carry an IPv4 address, and this machine's own addresses, public ones included. It
tests the address at the moment the connection resolves it, and again at every redirect. For the same reason it
connects directly and never through a proxy, which would resolve the name out of its sight, so behind a required
proxy every web source is `unreachable`. A source refused this way should be confirmed from a public source, never
fetched by other means.

## Brainstorm rounds

Every seat gets the same problem and returns `framing`, how it read the problem; `ideas`; and `questions` for the
user. Each idea has a `title`, a `description`, `wins_when`, the one `assumption` it rests on, the cheapest `test` of
that assumption, and any `precedents`, each with a source and an exact quote. `--ideas <n>` sets how many each seat
gives, 8 by default. The runtime gives every idea an id, `I-` and six hexadecimal digits.

Seats are told to produce options that differ in kind, and not to rank or recommend. Each seat also gets a lens, a
stance that at least half its ideas must come from, so that seats diverge: `precedent`, `subtraction`, `inversion`,
`first-principles`, `failure`, and `extremes`, handed out in that order. An idea that came from the lens is marked
`[lens]`. `--lens <text>` replaces the built-in lenses with the user's own, one per seat in order, and `--no-lens`
runs every seat with none.

## again

`again` continues a thread: each seat resumes its own conversation and gets the text after `--`, after the text of a
`--question-file` if there is one. A seat whose last round failed or was cancelled starts a new conversation instead,
and is told what it returned before.

The text after `--` may carry decisions, one per line, each a verb, one or more ids, and an optional note:

```text
pursue I-1a2b3c, I-4d5e6f
drop I-7a8b9c: needs a schema migration we cannot do
park I-0a1b2c
reject C-3d4e5f: the benchmark is from 2022
accept C-6a7b8c
reopen I-7a8b9c
```

For an idea, `pursue` and `accept` both record `pursued`, and `drop` and `reject` both record `dropped`. For a claim,
they record `accepted` and `rejected`. `park` records `parked`, and `reopen` clears a decision. The runtime records
decisions before the round starts and shows them to every seat, with the instruction not to bring back what was
dropped or rejected without new evidence. It prints a `Warning:` line for an id the thread does not have and for text
that looks like a decision but is not on its own line. Decisions are never read from a question file, which may be
committed or written by someone else; one that contains decision-like text gets a `Warning:` line too.

`--mode research|brainstorm` sets what the round asks for, and defaults to the thread's last mode:

- A brainstorm round after the first asks for more ideas unlike any in the pool. Every seat sees the whole pool, with
  the decisions on it, and may name the ideas a new one builds on. `--no-share` withholds the pool.
- A research round on a brainstorm thread shows every seat the pursued ideas and has it look for evidence for and
  against each one's assumption. A claim names the idea it bears on and whether it supports, contradicts, or refines
  it.
- A research round after the first stays independent unless `--share` is passed. With it, every seat sees the other
  seats' latest claims and is told to confirm, contradict, or sharpen them with sources of its own, so `result` shows
  which claims another seat stands behind and which it disputes.

A `--model` value is refused before anything is saved unless it is a plain model name, such as `gpt-6.2-astra` or
Claude Code's `opus[1m]`. A conversation id that a CLI reports and that it could read as an option is never resumed:
that seat's next round starts a new conversation.

## Jobs

A round runs as a detached background job and prints its job ID at once. `result --wait` and `status --wait` block
for up to `--wait-minutes` (default 5) and can be called again. `--wait` on `research`, `brainstorm`, or `again` runs
the round in the foreground instead and exits nonzero if no seat finished. `cancel` first writes a marker that the
worker watches for, so a cancel whose signal never arrives still stops the round, and a seat that had not started
when it arrived keeps its conversation.

A round is `completed` when at least one seat finished, and each seat reports its own outcome, so one researcher
failing never hides the others' reports and is never hidden by them. A seat whose output does not match the schema is
shown as returned, with a warning and no ids.

A researcher runs as the leader of its own process group, and the whole group is stopped when its seat ends, whichever
way it ends. `cancel` stops every researcher of a round, and a job whose worker died is settled the next time any
command reads it or its thread; seats whose results were saved keep them. In both cases the runtime also stops every
process it can still find below a researcher's CLI, since a CLI can start a command in a session of its own, outside
its process group. Such a command can outlive a CLI that is already gone when the runtime looks, because nothing ties
the two together any more. If one keeps a researcher's output open after its CLI exits, the runtime stops reading five
seconds after the CLI's group is gone, keeps what it printed, and says so with a `Warning:` line. A thread runs one
round at a time, and `result` shows an earlier round with the settings its seats ran with.

Two steps act on paths that anything with write access to the checkout could change between one system call and
the next: `check` opening a cited file, and `prune` removing a scratch directory. Each checks every directory on the
way and checks again after it opens, but Node offers no way to open or remove relative to a directory it holds, so a
concurrent writer that raced those calls could still win: a researcher of a round still running, or a process that
outlived its seat. While any round runs, `prune` leaves an idle thread that has a scratch directory whole, records
included, and removes it at the first prune once none runs. A scratch directory it cannot look up, as for want of
permission, stops `prune` with that error before the thread's records go.
