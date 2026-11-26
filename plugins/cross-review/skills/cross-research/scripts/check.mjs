// Tests each quote a researcher cited against the source it names, so the
// agent relaying the research starts from what is mechanically true: the
// passage is in the source, or it is not, or the source could not be read.
// Whether the passage supports the claim is still the agent's call.
//
// Everything a researcher returns is untrusted, so the addresses and paths
// here are too: nothing on this machine or its network is fetched, and no
// file outside the repository and the thread's directory is opened.

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

import { likelySecretPath } from "../../cross-review/scripts/runtime.mjs";
import { atomicWriteText } from "./support.mjs";
import { Parser } from "./vendor/parse5/parser/index.js";

export const CHECK_STATUSES = ["found", "partial", "missing", "unreachable", "unreadable"];

const REQUEST_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 120_000;
// The version of the text kept for a fetched page. A change to how a page is
// turned into text changes it, so text kept by an earlier version is fetched
// again instead of being read the new way.
const TEXT_FORMAT = 42;
// Deeper than this, a <sup> or <sub> is read as plain text, which bounds the
// work an adversarial page can make the check do.
const MAX_RAISE_DEPTH = 32;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 6;
const MIN_PIECE_CHARACTERS = 12;
const MIN_LOOSE_CHARACTERS = 12;
const PARTIAL_SHARE = 0.6;
const PARTIAL_WORDS = 6;
// Names the tool and nothing about who runs it.
const USER_AGENT = "cross-research-check (Node.js)";

// Why a source gave no text to search: it could not be reached, or what came
// back could not be read as text.
class SourceProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Raised and lowered digits change what a number says, as ten to the sixth
// is not 106, so a span of them is set off by marks that only the loose
// comparison ignores, written the same way whether a page uses a Unicode
// superscript or <sup>. A span opens and closes with different marks, so an
// exponent inside an exponent never reads as two exponents in a row.
const RAISED = "\uE000";
const RAISED_END = "\uE001";
const LOWERED = "\uE002";
const LOWERED_END = "\uE003";
// The marks are private-use characters. Each character of their block that a
// page, a file, or a quote holds itself, as an icon font's glyph, is written
// as ESCAPE and a character of its own, so that no input can write a mark and
// two different glyphs never read as one.
const ESCAPE = "\uE004";
const escapeMarks = (text) => text.replace(/[\uE000-\uE004]/g, (character) => `${ESCAPE}${String.fromCharCode(character.charCodeAt(0) + 5)}`);
// What a MathML formula or a native gauge reads as: one object, since no line
// of text says what a fraction, a root, or a meter shows, and it is a pair no
// input can write.
const OBJECT = `${ESCAPE}\uE00a`;
const RAISED_CHARACTERS = /[\u00b2\u00b3\u00b9\u2070\u2071\u2074-\u207f]/g;
const LOWERED_CHARACTERS = /[\u2080-\u208e\u2090-\u209c]/g;
// Spans that touch are one span, and an empty one is none, so ten with 2 and
// 3 raised reads the same whether a page writes it as one span or two.
const TOUCHING = new Set([RAISED_END + RAISED, RAISED + RAISED_END, LOWERED_END + LOWERED, LOWERED + LOWERED_END]);
const PRIVATE_REFUSAL = "it is on this machine or a private network, which the check does not fetch; look for the claim in a public source instead";

// What a quote and its source are both reduced to before comparing, so that
// typography, case, and line breaks never decide a match.
export function normalize(text) {
  return joinSpans(fold(String(text)))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    // A final sigma is a sigma, as case folding has it, whatever follows it.
    .replaceAll("\u03c2", "\u03c3");
}

// The characters a comparison sees: Unicode superscripts and subscripts as
// the marked spans a <sup> or <sub> becomes, compatibility forms folded,
// invisible characters left out, the direction marks among them, and
// quotation marks and dashes made plain. Invisible mathematical operators
// stay, as an invisible plus is what keeps 1 and a half from reading as 11,
// and so do directional embeddings, overrides, and isolates, which can change
// the order a reader sees digits in.
// A <sup> or <sub> is judged on the same, so what a match ignores, the
// judgment ignores too.
function fold(text) {
  return text
    .replace(RAISED_CHARACTERS, (character) => `${RAISED}${character.normalize("NFKC")}${RAISED_END}`)
    .replace(LOWERED_CHARACTERS, (character) => `${LOWERED}${character.normalize("NFKC")}${LOWERED_END}`)
    .normalize("NFKC")
    .replace(/[\u00ad\u061c\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

// Marks meet only where nothing stands between them, so each run of them is
// settled on its own, as a stack: a close then an open of the same kind joins
// two spans, and an open then a close leaves an empty span out.
function joinSpans(text) {
  // The marks of a direction's scope show nothing, so spans meet across them,
  // and the scope marks stay where they were.
  return text.replace(/(?:[\uE000-\uE003]|\uE004[\uE00b-\uE012])(?:[\uE000-\uE003]|\uE004[\uE00b-\uE012])+/g, (run) => {
    const kept = [];
    // Where the span marks still kept are, so each is met in one step.
    const spans = [];
    for (const token of run.match(/[\uE000-\uE003]|\uE004[\uE00b-\uE012]/g)) {
      if (token.length === 1 && spans.length && TOUCHING.has(kept[spans.at(-1)] + token)) {
        kept[spans.pop()] = "";
      } else {
        if (token.length === 1) spans.push(kept.length);
        kept.push(token);
      }
    }
    return kept.join("");
  });
}

// A looser form, without spacing, Markdown markers, or the marks of raised
// digits. A quote that matches only in this form is close to its source, but
// "now here" and "nowhere" are the same in it, and so are 10 with a raised 6 and 106, so it
// is never enough to call a quote found.
function loosen(normalized) {
  return normalized.replace(/[`*_\\ \uE000-\uE003]/g, "");
}

function inOrder(haystack, pieces) {
  let from = 0;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

// A combining mark belongs to the word it follows, as a vowel sign does, and
// the mark of a raised digit to the number it is on, so "10" is not a whole
// word of 10 with a raised 6, and "H" is not one of H2O with a lowered 2.
const WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_\uE000-\uE003]$/u;

// Whether the source holds the quote as whole words. A quote that starts or
// ends inside a longer word of the source, as "compatible" does inside
// "incompatible", says something the source does not.
// How the source holds the quote: "whole", as whole words; "directional",
// only inside text whose direction the page sets explicitly; "layout", only
// across an edge of an element whose box comes through var(), or against a
// word beyond one, which may stand apart on screen; "inside", only inside a
// longer word or an escaped glyph; or null.
function occurrence({ text: haystack, ranges, edges }, needle) {
  const [first, last] = [[...needle][0], [...needle].at(-1)].map((character) => WORD_CHARACTER.test(character));
  let seen = null;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    // An escaped glyph is one character on screen, so no match splits one.
    if (haystack[at - 1] === ESCAPE || haystack[end - 1] === ESCAPE) {
      seen ??= "inside";
      continue;
    }
    if (ranges && overlaps(ranges, at, end)) {
      seen = "directional";
      continue;
    }
    if (edges && crosses(edges, at, end)) {
      if (seen !== "directional") seen = "layout";
      continue;
    }
    const before = [...haystack.slice(Math.max(0, at - 2), at)].at(-1) ?? "";
    const after = [...haystack.slice(end, end + 2)][0] ?? "";
    const joinedBefore = first && WORD_CHARACTER.test(before);
    const joinedAfter = last && WORD_CHARACTER.test(after);
    if (!joinedBefore && !joinedAfter) return "whole";
    if (edges && (!joinedBefore || crosses(edges, at - 1, at + 1)) && (!joinedAfter || crosses(edges, end - 1, end + 1))) {
      if (seen !== "directional") seen = "layout";
      continue;
    }
    seen ??= "inside";
  }
  return seen;
}

// Whether any of the sorted places lies strictly between at and end.
function crosses(places, at, end) {
  let low = 0;
  let high = places.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (places[middle] <= at) low = middle + 1;
    else high = middle;
  }
  return low < places.length && places[low] < end;
}

// Whether any of the sorted, separate ranges meets [at, end).
function overlaps(ranges, at, end) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle][1] <= at) low = middle + 1;
    else high = middle;
  }
  return low < ranges.length && ranges[low][0] < end;
}

// Text inside an explicit directional embedding, override, or isolate may
// show in an order other than the one it is stored in, which no line of text
// can say, so a match that meets it is never found. Each such run is set off
// by marks no input can write and the controls themselves are left out, so
// that no quote has to carry them and none a page adds splits a passage. As
// in Unicode's bidirectional algorithm, a scope ends at its matching pop or
// with its paragraph, a pop inside an isolate ends nothing begun outside it,
// and past the deepest nesting the algorithm allows the rest of the paragraph
// counts, whatever pops follow.
const SCOPE_START = `${ESCAPE}\uE00b`;
const SCOPE_END = `${ESCAPE}\uE00c`;
const MAX_DIRECTIONAL_DEPTH = 125;
const DIRECTIONAL_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/;

// What ends a paragraph for Unicode's bidirectional algorithm.
const PARAGRAPH_SEPARATORS = new Set(["\n", "\r", "\u001c", "\u001d", "\u001e", "\u0085", "\u2029"]);
// The edges of an element that isolates its content, as a <bdi>, a <bdo>, or
// an element with dir does, and of one laid out apart, as a form control or
// the title is. Neither lets a control inside affect the text around it.
const ISOLATE_START = `${ESCAPE}\uE00d`;
const ISOLATE_END = `${ESCAPE}\uE00e`;
const ATOMIC_START = `${ESCAPE}\uE00f`;
const ATOMIC_END = `${ESCAPE}\uE010`;
// Where an inline element's isolation, set through var(), may or may not
// hold its content apart from the text around it: read as a line separator
// is, but standing between no words, so "1" and "00" still make 100.
const AMBIGUOUS = `${ESCAPE}\uE011`;
// Where an element's box, set through var(), may or may not end the line, so
// the words on either side may run together or stand apart. The search reads
// the text both ways.
const UNSURE_BREAK = `${ESCAPE}\uE012`;

// The page, and the inside of each element that isolates or is laid out
// apart, has a stack of its own, saved and restored around the element, so
// that no control inside it reaches past it, as CSS lays such an element out.
// A paragraph break inside an isolating element breaks the paragraph around
// it too, so it ends the stacks outside it as well, but not the stack outside
// a form control, which is laid out as one object in its line.
class Reading {
  constructor() {
    this.outer = [];
    this.breaks = 0;
    this.separators = 0;
    this.context = Reading.fresh();
  }

  // A context's stack, whether a direction control has come in its paragraph,
  // and whether a line separator after one leaves the rest of it uncertain.
  static fresh() {
    return { open: [], isolates: 0, overflow: false, controlled: false, ambiguous: false };
  }

  inside() {
    return this.context.open.length > 0 || this.context.overflow || this.context.ambiguous;
  }

  // Paragraph breaks and line separators are counted, so that leaving an
  // element after one updates the context outside it in constant time: a
  // break inside an isolating element ends the paragraph around it too, and
  // so may a separator, while a form control starts counts of its own, since
  // nothing inside it reaches its line.
  enter(atomic) {
    this.outer.push({ saved: this.context, atomic, breaks: this.breaks, separators: this.separators });
    if (atomic) {
      this.breaks = 0;
      this.separators = 0;
    }
    this.context = Reading.fresh();
  }

  leave() {
    if (!this.outer.length) return;
    const { saved, atomic, breaks, separators } = this.outer.pop();
    if (atomic) {
      this.context = saved;
      this.breaks = breaks;
      this.separators = separators;
      return;
    }
    if (breaks !== this.breaks) {
      this.context = Reading.fresh();
      return;
    }
    if (separators !== this.separators && saved.controlled) saved.ambiguous = true;
    this.context = saved;
  }

  paragraph() {
    this.context = Reading.fresh();
    this.breaks += 1;
  }

  separator() {
    if (this.context.controlled) this.context.ambiguous = true;
    this.separators += 1;
  }

  control(code) {
    const context = this.context;
    context.controlled = true;
    if ((code >= 0x202a && code <= 0x202e && code !== 0x202c) || (code >= 0x2066 && code <= 0x2068)) {
      if (context.open.length >= MAX_DIRECTIONAL_DEPTH) {
        context.overflow = true;
      } else {
        context.open.push(code);
        if (code >= 0x2066) context.isolates += 1;
      }
    } else if (!context.overflow && code === 0x202c && context.open.length && context.open.at(-1) <= 0x202e) {
      context.open.pop();
    } else if (!context.overflow && code === 0x2069 && context.isolates > 0) {
      while (context.open.pop() < 0x2066);
      context.isolates -= 1;
    }
  }
}

// A line separator stands where browsers disagree on whether a line ends a
// paragraph. It ends none here, but once a direction control has come in its
// paragraph, the two ways of reading it could disagree on what follows, so
// the rest of that paragraph counts as in a scope, whichever is right.
function markDirectional(text) {
  if (!DIRECTIONAL_CONTROLS.test(text)) return text;
  const reading = new Reading();
  const out = [];
  let inScope = false;
  const settle = () => {
    const now = reading.inside();
    if (now && !inScope) out.push(SCOPE_START);
    if (!now && inScope) out.push(SCOPE_END);
    inScope = now;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const code = text.charCodeAt(index);
    if (character === ESCAPE && index + 1 < text.length) {
      const mark = text.slice(index, index + 2);
      if (mark === ISOLATE_START || mark === ATOMIC_START) reading.enter(mark === ATOMIC_START);
      else if (mark === ISOLATE_END || mark === ATOMIC_END) reading.leave();
      else if (mark === AMBIGUOUS || mark === UNSURE_BREAK) reading.separator();
      settle();
      out.push(mark);
      index += 1;
      continue;
    }
    if (PARAGRAPH_SEPARATORS.has(character)) {
      reading.paragraph();
      settle();
      out.push(character);
      continue;
    }
    if (character === "\u2028") {
      reading.separator();
      settle();
      out.push(character);
      continue;
    }
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      reading.control(code);
      settle();
      continue;
    }
    out.push(character);
  }
  if (inScope) out.push(SCOPE_END);
  return out.join("");
}

// The text compared, without the marks, the ranges of it they set off, and
// the places where an element whose box comes through var() meets a word on
// each side. Marks nest, as an element that sets direction can hold text that
// sets it again, so a range lasts until the outermost one closes.
function unmarkDirectional(marked) {
  if (!/\uE004[\uE00b-\uE012]/.test(marked)) return { text: marked, ranges: null, edges: null };
  if (!/\uE004[\uE00b-\uE011]/.test(marked)) return unmarkEdges(marked);
  const kept = [];
  const ranges = [];
  const edges = [];
  let start = null;
  let depth = 0;
  for (let index = 0; index < marked.length; index += 1) {
    const mark = marked.slice(index, index + 2);
    if (mark === SCOPE_START) {
      if (depth === 0) start = kept.length;
      depth += 1;
      index += 1;
    } else if (mark === SCOPE_END) {
      if (depth > 0) depth -= 1;
      // A range left empty still counts where it parts runs, as an empty
      // isolate does: 123 and 456 show as 456123 in a right-to-left paragraph.
      if (depth === 0 && start !== null) {
        ranges.push([start, kept.length]);
        start = null;
      }
      index += 1;
    } else if (mark === UNSURE_BREAK) {
      edges.push(kept.length);
      index += 1;
    } else if (mark === ISOLATE_START || mark === ISOLATE_END || mark === ATOMIC_START || mark === ATOMIC_END || mark === AMBIGUOUS) {
      index += 1;
    } else if (marked[index] !== " " || (kept.length && kept.at(-1) !== " ")) {
      // A space beside a mark collapses with the one before it.
      kept.push(marked[index]);
    }
  }
  if (start !== null) ranges.push([start, kept.length]);
  if (kept.at(-1) === " ") kept.pop();
  const parting = ranges.filter(([from, to]) => to > from || partsRuns(from, kept));
  return { text: kept.join(""), ranges: parting.length ? parting : null, edges: between(edges, kept) };
}

// The same for a text whose only marks are those edges, as on a page with no
// direction controls, found without walking each character.
function unmarkEdges(marked) {
  const pieces = [];
  const edges = [];
  let length = 0;
  let afterSpace = true;
  for (const [index, whole] of marked.split(UNSURE_BREAK).entries()) {
    if (index > 0) edges.push(length);
    const piece = afterSpace && whole.startsWith(" ") ? whole.slice(1) : whole;
    if (!piece) continue;
    pieces.push(piece);
    length += piece.length;
    afterSpace = piece.endsWith(" ");
  }
  const text = pieces.join("").replace(/ $/, "");
  return { text, ranges: null, edges: between(edges, text) };
}

// Whether an empty range at a place parts runs: between two characters, and
// between two groups of digits even beside a space, which may be a no-break
// space that groups them, before folding made it an ordinary one.
function partsRuns(at, text) {
  if (at <= 0 || at >= text.length) return false;
  if (text[at - 1] !== " " && text[at] !== " ") return true;
  return DIGIT.test(shownBeside(text, at - 1, -1)) && DIGIT.test(shownBeside(text, at, 1));
}

// The character a reader sees next to a place, going one way past a space and
// the marks of raised digits, whole where it lies outside the basic plane.
function shownBeside(text, from, step) {
  let at = from;
  if (text[at] === " ") at += step;
  while (at >= 0 && at < text.length && /[\uE000-\uE003]/.test(text[at])) at += step;
  if (at < 0 || at >= text.length) return "";
  if (step < 0 && /[\udc00-\udfff]/.test(text[at]) && /[\ud800-\udbff]/.test(text[at - 1] ?? "")) return text[at - 1] + text[at];
  if (step > 0 && /[\ud800-\udbff]/.test(text[at])) return text[at] + (text[at + 1] ?? "");
  return text[at];
}

// The edges with a word on each side, where whether they part words matters.
function between(edges, text) {
  const meeting = edges.filter((at) => at > 0 && at < text.length && text[at - 1] !== " " && text[at] !== " ");
  return meeting.length ? meeting : null;
}

const compared = (marked) => unmarkDirectional(normalize(marked));
const prepared = (text) => compared(markDirectional(text));

// The longest run of the quote's consecutive words that the source contains.
function longestRun(haystack, words) {
  let best = 0;
  for (let start = 0, end = 1; start < words.length && end <= words.length; ) {
    if (haystack.includes(words.slice(start, end).join(" "))) {
      best = Math.max(best, end - start);
      end += 1;
    } else {
      start += 1;
      if (end <= start) end = start + 1;
    }
  }
  return best;
}

// A source's text in the forms a quote is searched in, made once per source.
// Where an element's box comes through var(), the words at its edges run
// together, and the places are kept, so that a quote is found only where it
// holds whether they part words or not. A second reading, with them apart, is
// made only once a quote is not found in the first.
function searchable({ text, pdf }) {
  const joined = reading(text, pdf);
  if (!text.includes(UNSURE_BREAK)) return { joined, apart: null };
  let apart = null;
  return { joined, apart: () => (apart ??= reading(text.replaceAll(UNSURE_BREAK, "\u2028"), pdf)) };
}

function reading(text, pdf) {
  const marked = markDirectional(text);
  const haystacks = [compared(marked)];
  // A PDF breaks a word across lines with a hyphen that the quote may not
  // carry. Only a hyphen that ends a line is taken out, and only in a PDF's
  // text: anywhere else it may be a minus sign. The lines' scopes of
  // direction are found first, as they were before the lines were joined.
  if (pdf) {
    const joined = marked.replace(/(\p{L})((?:\uE004[\uE00b-\uE011])*)-((?:\uE004[\uE00b-\uE011])*)\r?\n((?:[ \t]|\uE004[\uE00b-\uE011])*)(\p{L})/gu,
      (whole, before, marksBefore, marksAfter, indentation, after) => `${before}${marksBefore}${marksAfter}${indentation.replace(/[ \t]/g, "")}${after}`);
    haystacks.push(compared(joined));
  }
  return { haystacks, loose: haystacks.map(({ text: haystack }) => loosen(haystack)) };
}

const LAYOUT = { status: "partial", detail: "it depends on whether an element whose layout the page sets through a CSS variable parts the words beside it, which the check cannot tell" };

// A quote that holds only with the words at such an edge apart depends on a
// layout the check cannot follow, and one that holds in neither reading gets
// the closer of their answers.
function matchSearchable({ joined, apart }, quote) {
  const quoted = prepared(escapeMarks(String(quote)));
  const first = matchReading(joined, quoted);
  if (first.status === "found" || !apart) return first;
  const second = matchReading(apart(), quoted);
  if (second.status === "found") return LAYOUT;
  return first.status === "partial" ? first : second.status === "partial" ? second : first;
}

function matchReading({ haystacks, loose }, quoted) {
  const needle = quoted.text;
  if (!needle) return { status: "missing", detail: "the quote is empty" };
  const occurrences = haystacks.map((haystack) => occurrence(haystack, needle));
  if (occurrences.includes("whole")) {
    if (quoted.ranges) return { status: "partial", detail: "the quote sets the direction of its own text, so a reader may see it in another order" };
    return { status: "found", detail: null };
  }
  if (occurrences.includes("directional")) return { status: "partial", detail: "it is in text whose direction the page sets explicitly, so a reader may see it in another order" };
  if (occurrences.includes("layout")) return LAYOUT;
  if (occurrences.includes("inside")) return { status: "partial", detail: "it begins or ends inside a longer word of the source" };
  const pieces = needle.split(/\s*(?:\[\.\.\.\]|\.\.\.)\s*/).filter((piece) => piece.length >= MIN_PIECE_CHARACTERS);
  if (pieces.length > 1 && haystacks.some(({ text: haystack }) => inOrder(haystack, pieces))) {
    return { status: "partial", detail: "its parts appear in order, but not as one passage" };
  }
  const tight = loosen(needle);
  if (tight.length >= MIN_LOOSE_CHARACTERS && loose.some((haystack) => haystack.includes(tight))) {
    return { status: "partial", detail: "it matches only when spacing, Markdown markers, or raised and lowered digits are ignored" };
  }
  const words = needle.split(" ");
  const run = Math.max(...haystacks.map(({ text: haystack }) => longestRun(haystack, words)));
  if (run >= PARTIAL_WORDS && run / words.length >= PARTIAL_SHARE) {
    return { status: "partial", detail: `${run} of its ${words.length} words appear as one passage` };
  }
  return { status: "missing", detail: "the source was read and does not contain it" };
}

// `text` is a source's text as the check reads it, from htmlToText or the
// loaders, which have already escaped what it holds of the marks' block.
export function matchQuote(text, quote, { pdf = false } = {}) {
  return matchSearchable(searchable({ text, pdf }), quote);
}

// Elements that end a line of text. Any other element, a custom one included,
// sits inside a sentence without breaking it, as a browser renders it.
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "li", "main", "nav",
  "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "xmp"
]);
// Elements that sit inside a paragraph, as form controls do and the title
// does in a document's head, so a space keeps their words apart without
// ending a direction a page set around them.
const SEPARATED_ELEMENTS = new Set(["button", "option", "select", "textarea", "title"]);
// CSS as an inline style holds it: comments gone, strings and url()s made
// spaces so no "/*" or ";" inside one counts, and escapes decoded.
// Read left to right as CSS's tokenizer reads it: an escape is decoded where
// it stands, so an escaped quote opens no string and an escaped url() is one.
function cssText(value) {
  let out = "";
  // A quoted string, from its opening quote, skipped to just past its end.
  const skipString = (from) => {
    const quote = value[from];
    let index = from + 1;
    while (index < value.length && value[index] !== quote && !/[\n\r\f]/.test(value[index])) index += value[index] === "\\" ? 2 : 1;
    return index + 1;
  };
  for (let index = 0; index < value.length; ) {
    const character = value[index];
    if (character === "\\") {
      const hex = /^[0-9a-f]{1,6}/i.exec(value.slice(index + 1, index + 7));
      if (hex) {
        index += 1 + hex[0].length;
        if (value.startsWith("\r\n", index)) index += 2;
        else if (/[ \t\n\r\f]/.test(value[index] ?? "")) index += 1;
        const code = Number.parseInt(hex[0], 16);
        // An escaped ";" or ":", in hex or not, is part of a value, never the
        // syntax around it.
        out += code > 0 && code <= 0x10ffff && code !== 0x3b && code !== 0x3a ? String.fromCodePoint(code) : "\ufffd";
      } else {
        const escaped = value[index + 1] ?? "";
        out += escaped === ";" || escaped === ":" ? "\ufffd" : escaped;
        index += 2;
      }
    } else if (value.startsWith("/*", index)) {
      const close = value.indexOf("*/", index + 2);
      index = close < 0 ? value.length : close + 2;
    } else if (character === '"' || character === "'") {
      index = skipString(index);
      out += " ";
    } else if (character === "(" && /(?:^|[^-\w])url$/i.test(out)) {
      // A url()'s argument says nothing about direction, whatever it holds.
      out = `${out.slice(0, -3)} `;
      index += 1;
      while (index < value.length && value[index] !== ")") {
        if (value[index] === "\\") index += 2;
        else if (value[index] === '"' || value[index] === "'") index = skipString(index);
        else index += 1;
      }
      index += 1;
    } else {
      out += character;
      index += 1;
    }
  }
  return out;
}

// The values that the properties read here accept, the CSS-wide ones included.
const CSS_WIDE = "initial|inherit|unset|revert|revert-layer";
const VALID_STYLE = {
  direction: new RegExp(`^(?:ltr|rtl|${CSS_WIDE})$`),
  "unicode-bidi": new RegExp(`^(?:normal|embed|isolate|bidi-override|isolate-override|plaintext|${CSS_WIDE})$`),
  "white-space": new RegExp(`^(?:normal|nowrap|pre|pre-wrap|pre-line|${CSS_WIDE}|(?:(?:collapse|discard|preserve|preserve-breaks|preserve-spaces|break-spaces)(?:\\s+(?:wrap|nowrap))?)|(?:(?:wrap|nowrap)(?:\\s+(?:collapse|discard|preserve|preserve-breaks|preserve-spaces|break-spaces))?))$`),
  "white-space-collapse": new RegExp(`^(?:collapse|preserve|preserve-breaks|preserve-spaces|break-spaces|discard|${CSS_WIDE})$`),
  display: { test: validDisplay }
};
// Whether a display value is one CSS accepts: a single keyword, or an outer
// and an inner type in either order, with list-item only beside a flow one.
function validDisplay(value) {
  if (new RegExp(`^(?:none|contents|inline-(?:block|flex|grid|table)|table-(?:row|cell|caption|row-group|header-group|footer-group|column|column-group)|${CSS_WIDE})$`).test(value)) return true;
  const words = value.split(/\s+/);
  if (new Set(words).size !== words.length || words.length > 3) return false;
  const outer = words.filter((word) => /^(?:inline|block|run-in)$/.test(word));
  const inner = words.filter((word) => /^(?:flow|flow-root|table|flex|grid|ruby)$/.test(word));
  const item = words.filter((word) => word === "list-item");
  if (outer.length > 1 || inner.length > 1 || outer.length + inner.length + item.length !== words.length) return false;
  return !item.length || !inner.length || /^flow(?:-root)?$/.test(inner[0]);
}

// A value set through a custom property, which the check cannot follow.
const VARIABLE = /\bvar\(/;
// What white-space sets its collapse longhand to.
const COLLAPSE_OF = { normal: "collapse", nowrap: "collapse", pre: "preserve", "pre-wrap": "preserve", "pre-line": "preserve-breaks" };
function whiteSpaceCollapse(value) {
  if (Object.hasOwn(COLLAPSE_OF, value) || VARIABLE.test(value) || new RegExp(`^(?:${CSS_WIDE})$`).test(value)) return COLLAPSE_OF[value] ?? value;
  // The collapse part of a shorthand that names one, which defaults to collapse.
  return value.split(/\s+/).find((word) => word !== "wrap" && word !== "nowrap") ?? "collapse";
}
// The value each property of an element's inline style takes, as the cascade
// picks it: the last declaration, unless an earlier one is important.
function inlineStyle(node) {
  const declared = new Map();
  const style = node.attrs?.find(({ name }) => name === "style")?.value;
  if (!style) return declared;
  for (const declaration of cssText(style).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const raw = declaration.slice(colon + 1).trim().toLowerCase();
    const important = /!\s*important$/.test(raw);
    const value = raw.replace(/!\s*important$/, "").trim();
    // A value the property does not accept is dropped, as CSS drops it, and
    // leaves an earlier one standing; one set through var() stands, as an
    // uncertain one. The white-space shorthand sets its collapse longhand, in
    // the order the declarations come.
    const accepted = VARIABLE.test(value) || (Object.hasOwn(VALID_STYLE, property) && VALID_STYLE[property].test(value));
    if (!accepted) continue;
    const longhand = property === "white-space" ? "white-space-collapse" : property;
    const longValue = property === "white-space" ? whiteSpaceCollapse(value) : value;
    if (declared.get(longhand)?.important && !important) continue;
    declared.set(longhand, { value: longValue, important });
  }
  return new Map([...declared].map(([property, { value }]) => [property, value]));
}

// What an element does to the direction of its text, as HTML's own style
// sheet and its inline style have it: { direction, bidi }, where direction is
// "ltr", "rtl", "auto", or null to inherit, and bidi is its unicode-bidi.
function directionOf(node, name, style, parentBidi) {
  const dir = node.attrs.find(({ name: attribute }) => attribute === "dir")?.value.toLowerCase();
  const valid = dir === "ltr" || dir === "rtl" || dir === "auto" ? dir : null;
  let direction = valid ?? (name === "bdi" ? "auto" : null);
  const declared = style.get("direction");
  if (declared && VARIABLE.test(declared)) direction = "uncertain";
  else if (declared === "ltr" || declared === "rtl") direction = declared;
  else if (declared === "initial") direction = "ltr";
  // A rollback keeps dir's direction, as HTML's own style sheet sets it and
  // Firefox has it, though Chrome and WebKit inherit past it on revert, which
  // the caller weighs against what the element inherits.
  else if (declared === "inherit" || declared === "unset") direction = null;
  let bidi = ISOLATED_BY_DEFAULT.has(name) ? "isolate" : "normal";
  if (name === "bdo") bidi = "isolate-override";
  else if ((name === "textarea" || name === "pre") && valid === "auto") bidi = "plaintext";
  else if (name === "bdi" || name === "output" || valid) bidi = "isolate";
  const declaredBidi = style.get("unicode-bidi");
  if (declaredBidi && VARIABLE.test(declaredBidi)) bidi = "uncertain";
  else if (declaredBidi === "initial" || declaredBidi === "unset") bidi = "normal";
  else if (declaredBidi === "inherit") bidi = parentBidi;
  else if (declaredBidi && !/^(?:revert|revert-layer)$/.test(declaredBidi)) bidi = declaredBidi;
  return { direction, bidi, reverted: declared === "revert" && direction !== null };
}

// The elements HTML's own style sheet gives unicode-bidi: isolate.
const ISOLATED_BY_DEFAULT = new Set([
  "address", "blockquote", "center", "div", "figure", "figcaption", "footer", "form", "header", "hr", "legend", "listing",
  "main", "p", "plaintext", "pre", "summary", "xmp", "article", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup",
  "nav", "search", "section", "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th", "dir",
  "dd", "dl", "dt", "menu", "ol", "ul", "li", "bdi", "output"
]);

// Whether an element's own markup keeps it from being laid out, as hidden or
// an inline display: none does, or HTML's own style sheet, which hides a
// closed dialog and a popover until it opens; hidden="until-found" is laid
// out all the same.
function notLaidOut(node, style) {
  const display = style.get("display");
  const has = (attribute) => node.attrs.some(({ name }) => name === attribute);
  const closed = node.tagName === "dialog" ? !has("open") : has("popover");
  // revert rolls back to that style sheet, past what hidden sets, a hint at
  // the author's level, as browsers have it; revert-layer does not.
  if (display === "revert") return closed;
  if (display && display !== "revert-layer") return display === "none";
  const hidden = node.attrs.find(({ name }) => name === "hidden");
  return closed || (Boolean(hidden) && hidden.value.toLowerCase() !== "until-found");
}

// Whether an element's line breaks show as written: by default for the
// preformatted elements, or as its inline white-space says, or as its
// parent's do, which null leaves them.
function keepsLineBreaks(name, style) {
  const collapse = style.get("white-space-collapse");
  if (collapse && VARIABLE.test(collapse)) return "uncertain";
  if (collapse) return /^(?:collapse|discard|preserve-spaces|initial)$/.test(collapse) ? false : /^(?:preserve|preserve-breaks|break-spaces)$/.test(collapse) ? true : null;
  return PREFORMATTED.has(name) ? true : null;
}

// Where an inline display puts an element's box: "block" for one that ends a
// paragraph at its edges, "atomic" for an inline-level one that holds its
// content apart, "inline" for one that sits in its line, "contents" or "none"
// for no box, "uncertain" for one set through var(), or null for a value not
// given, in either the one-keyword or the two-keyword form.
function boxOf(display) {
  if (!display) return null;
  if (VARIABLE.test(display)) return "uncertain";
  if (display === "contents" || display === "none") return display;
  if (display === "initial" || display === "unset") return "inline";
  // inherit takes the parent's box and a rollback the element's own default,
  // which the caller knows.
  if (display === "inherit") return "inherit";
  if (display === "revert" || display === "revert-layer") return null;
  const words = display.split(/\s+/);
  if (display === "ruby") return "inline";
  if (words.includes("inline") || /^inline-/.test(display) || display.startsWith("run-in")) return /^inline-|flow-root|table|flex|grid/.test(display) && !display.startsWith("run-in") ? "atomic" : "inline";
  return "block";
}

// The direction a text's first strong character gives, as HTML's auto
// directionality finds it: a letter, or a mark that is strong, of bidi type
// L, R, or AL, or null when there is none.
const STRONG = /[\p{L}\p{Nl}\p{Mc}\u200e\u200f\u061c]/u;
// Right-to-left scripts' blocks, whose characters are of type R or AL except
// their digits, combining marks, and a few separators, which are weak or
// neutral, as Hebrew's maqaf is strong where a Latin hyphen is not.
const RTL_STRONG = /[\u0590-\u08ff\u200f\u061c\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
const RTL_WEAK = /[\p{Mn}\p{Me}\u0600-\u0605\u060c\u066a-\u066c\u06dd\u06de\u06e9\u08e2]|(?![\u07c0-\u07c9\u{1e950}-\u{1e959}])\p{Nd}/u;
// The first strong character of a subtree the walk does not read, an SVG, a
// gauge, or a hidden element, for an auto direction still waiting on one, as
// HTML reads its text all the same, past what it skips everywhere.
const SKIPPED_FOR_AUTO = new Set(["bdi", "script", "style", "textarea", "template"]);
function gatherStrong(root, entry) {
  if (!entry || entry.found !== null) return;
  const pending = [root];
  while (pending.length && entry.found === null) {
    const node = pending.pop();
    if (node.nodeName === "#text") {
      entry.found = firstStrong(node.value);
      continue;
    }
    // What HTML's algorithm passes over are HTML elements, so an SVG's own
    // dir or style is read like any other.
    const passed = node.namespaceURI === HTML_NAMESPACE && (SKIPPED_FOR_AUTO.has(node.tagName) || node.attrs.some(({ name, value }) => name === "dir" && /^(?:ltr|rtl|auto)$/i.test(value)));
    if (passed) continue;
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index -= 1) pending.push(node.childNodes[index]);
  }
}

// HTML's text node directionality takes the first strong code point of the
// text, inside a Unicode isolate or not, as browsers do.
function firstStrong(text) {
  for (const character of text) {
    if (RTL_STRONG.test(character) && !RTL_WEAK.test(character)) return "rtl";
    if (STRONG.test(character)) return "ltr";
  }
  return null;
}

// Elements whose line breaks show as written.
const PREFORMATTED = new Set(["pre", "textarea", "xmp", "listing", "plaintext"]);
// Elements whose content a browser does not show as text. Nothing drawn in
// SVG is read either, since its text is mostly the titles of icons.
const HIDDEN_ELEMENTS = new Set(["script", "style", "noscript", "iframe", "noembed", "noframes", "template", "object"]);
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
// Text that shows something, as a hidden block's must for it to stand apart.
const SHOWN = /[^\s\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

// A number as Intl.NumberFormat writes one in any locale and numbering
// system: decimal digits of every script and the Chinese ones, with the
// separators and signs it puts between them once folding has made its minus
// signs, apostrophes, and spaces plain and left out its direction marks.
const DIGITS = "\\p{Nd}\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d";
const DIGIT = new RegExp(`[${DIGITS}]`, "u");
// Invisible operators may stand between its parts too, as in 2 times 3.
const NUMBER = new RegExp(`^[\\s${DIGITS}+\\-=().,'\u060c\u066b\u066c\u2e41\u2061-\u2064\uE000-\uE003]*$`, "u");

// A <sup> or <sub> is judged once everything in it has been read, from the
// text it shows: a number in one, as an exponent or a chemical formula, gets
// its marks, and a footnote or a symbol, which reads the same inline, does
// not. An inner span counts as part of that number, whether a tag or a
// Unicode superscript wrote it, so an exponent of an exponent keeps both
// levels.
function markRaised(parts, frame) {
  // Directional controls around its digits do not stop it being a number,
  // and a formula counts as one, as a fraction for an exponent does.
  const inner = fold(parts.slice(frame.at + 1).join("")).replace(/[\u202a-\u202e\u2066-\u2069]/g, "").replaceAll(OBJECT, "0").replace(/\uE004[\uE00b-\uE012]/g, "");
  if (!DIGIT.test(inner) || !NUMBER.test(inner)) return;
  const [opening, closing] = frame.name === "sup" ? [RAISED, RAISED_END] : [LOWERED, LOWERED_END];
  parts[frame.at] = opening;
  parts.push(closing);
}

// The text a reader sees. The page is parsed by the rules browsers follow,
// so an end tag left out, markup spelled inside a script, or an inline SVG
// ends each element where it ends on screen.
export function htmlToText(html) {
  const parts = [];
  const raised = [];
  // Whether line breaks show as written, for each element that says.
  const preserving = [];
  // The direction each open element's text takes, the page's first, and each
  // one's computed unicode-bidi, which a child's inherit takes.
  const directions = [];
  const bidis = [];
  // Each open element's box, which a child's display: inherit takes.
  const boxes = [];
  // How many characters of text have been read, so an element can tell
  // whether it held any.
  let read = 0;
  // How many open elements are not laid out, inside which no break ends a
  // paragraph.
  let unseen = 0;
  // The elements whose direction, or whose parent's, waits on content not yet
  // read, judged once the page is read.
  const deferred = [];
  // Those of them inside what is hidden, by where each begins, so that one
  // can be dropped if nothing there shows.
  const deferredAt = new Map();
  // For each element HTML's auto directionality treats apart, a <bdi>,
  // a textarea, or one with dir, an entry that gathers its first strong
  // character when its direction is auto, and null when it is not, so the
  // text inside it counts for no element around it.
  const autos = [];
  // The edge of a block ends a paragraph, and so do a <br> and a line break
  // written in preformatted text, which CSS counts as forced paragraph
  // breaks. One written anywhere else is only a space, as is a carriage
  // return a character reference writes, as a browser lays them out.
  // How many open elements have a box set through var(), which may be none.
  let unsureBoxes = 0;
  // The parts that show nothing inside an element that is not laid out, or
  // whose box may be none, its spaces and its invisible text, which are
  // dropped when nothing in it shows, since such an element parts no words
  // then, or only at its edges.
  const unshown = [];
  const loose = (part) => {
    if (unseen > 0 || unsureBoxes > 0) unshown.push(parts.length);
    parts.push(part);
  };
  const paragraph = () => loose(unseen > 0 ? " " : "\n");
  // Read depth first without recursion, since a page can nest elements more
  // deeply than the call stack goes: each element is followed on the stack by
  // a note that closes it once everything inside it has been read.
  const pending = [Parser.parse(String(html))];
  while (pending.length) {
    const node = pending.pop();
    if (node.closes !== undefined) {
      const shown = read > node.readAt;
      if (node.embeds) parts.push("\u202c");
      if (node.marksIsolation) parts.push(ISOLATE_END);
      // A hidden element that shows nothing is not laid out, so it parts no
      // runs and sets no scope, and an inline isolate that is laid out and
      // shows nothing parts the runs beside it, whatever its direction. A
      // scope inside what is hidden stands only if something there shows.
      const scoped = !node.unseen || shown;
      const emptyIsolate = node.marksIsolation && !node.block && !shown && !node.unseen;
      // Where the element's own scope is written, which a hidden ancestor
      // drops if nothing in it shows, once the element's own content is
      // settled below.
      const scopeMarks = [];
      if (((node.scope === true && scoped) || emptyIsolate) && !shown) {
        // One that shows nothing holds no text to reorder, only the boundary
        // it sets, which an empty range at its start keeps.
        parts[node.scopeAt] = SCOPE_START + SCOPE_END;
        scopeMarks.push(node.scopeAt);
      } else if ((node.scope === true && scoped) || emptyIsolate) {
        parts[node.scopeAt] = SCOPE_START;
        scopeMarks.push(node.scopeAt, parts.length);
        parts.push(SCOPE_END);
      } else if (node.scope && scoped) {
        const entry = { ...node.scope, scopeAt: node.scopeAt, endAt: parts.length, dropped: false };
        deferred.push(entry);
        scopeMarks.push(node.scopeAt);
        deferredAt.set(node.scopeAt, entry);
        parts.push("");
      }
      if (node.direction) directions.pop();
      bidis.pop();
      boxes.pop();
      if (node.apart) autos.pop();
      // Closed in the reverse of the order it opened, so that no edge of the
      // element lands inside the marks of its raised digits.
      if (node.frame) markRaised(parts, raised.pop());
      if (node.preserves !== null) preserving.pop();
      if (node.unseen || node.unsureBox) {
        // Direction controls stay outside what is hidden, since a box set
        // through var() holds in nothing they begin.
        while (unshown.length && unshown.at(-1) >= node.blankFrom) {
          const index = unshown.pop();
          if (shown) continue;
          parts[index] = unseen > 0 ? "" : parts[index].replace(/[^\u202a-\u202e\u2066-\u2069]+/g, "");
          const entry = deferredAt.get(index);
          if (entry) entry.dropped = true;
        }
        if (shown && node.apartAt !== null) {
          parts[node.apartAt] = " ";
          parts.push(" ");
        }
      }
      if (unseen > 0 && !node.unseen) unshown.push(...scopeMarks);
      if (node.unseen && !node.atomic) parts.push(ATOMIC_END);
      if (node.atomic) {
        parts.push(ATOMIC_END);
        if (node.control && !node.unsureBox) loose(" ");
      }
      if (node.block) paragraph();
      if (node.unseen) unseen -= 1;
      if (node.unsureBox) unsureBoxes -= 1;
      if (node.unsure) loose(node.unsure);
    } else if (node.nodeName === "#text") {
      const gathering = autos.at(-1);
      if (gathering && gathering.found === null) gathering.found = firstStrong(node.value);
      // A carriage return a character reference writes is a space where line
      // breaks collapse; where they show, browsers disagree on whether it ends
      // a paragraph, so it is a line separator, which reads both ways.
      // Where whether line breaks show is set through var(), every one is uncertain.
      const shows = preserving.at(-1);
      const text = escapeMarks(node.value).replace(/\r\n|\n|\r/g, (line) => (!shows ? " " : shows === "uncertain" || line === "\r" ? "\u2028" : "\n"));
      if (SHOWN.test(node.value)) {
        read += 1;
        parts.push(text);
      } else loose(text);
    } else if ((node.namespaceURI === MATHML_NAMESPACE && node.tagName === "math") || (node.namespaceURI === HTML_NAMESPACE && (node.tagName === "meter" || node.tagName === "progress"))) {
      // A browser draws a gauge, not the text that stands in for it.
      parts.push(OBJECT);
      read += 1;
      gatherStrong(node, autos.at(-1));
    } else if (node.childNodes && (node.namespaceURI === SVG_NAMESPACE || (node.namespaceURI === HTML_NAMESPACE && HIDDEN_ELEMENTS.has(node.tagName)))) {
      gatherStrong(node, autos.at(-1));
    } else if (node.childNodes) {
      const name = node.namespaceURI === HTML_NAMESPACE ? node.tagName : "";
      const style = name ? inlineStyle(node) : new Map();
      const hidden = Boolean(name) && notLaidOut(node, style);
      if (name === "br") {
        const declaredBox = boxOf(style.get("display"));
        if (declaredBox === "uncertain" || (declaredBox === "inherit" && boxes.at(-1) === "uncertain")) loose(UNSURE_BREAK);
        else if (!hidden) paragraph();
        continue;
      }
      const declaredBox = boxOf(style.get("display"));
      const box = declaredBox === "inherit" ? boxes.at(-1) ?? "inline" : declaredBox;
      // What is not laid out has no box whose edges end a paragraph; whether
      // it stands apart from the words around it is settled at its end.
      const block = !hidden && (box ? box === "block" : BLOCK_ELEMENTS.has(name));
      // A hidden block, or a popover, which opens as a block of its own.
      const popover = Boolean(name) && node.attrs.some(({ name: attribute }) => attribute === "popover");
      const hiddenBlock = hidden && (BLOCK_ELEMENTS.has(name) || popover);
      boxes.push(box ?? (BLOCK_ELEMENTS.has(name) || popover ? "block" : "inline"));
      const control = !hidden && SEPARATED_ELEMENTS.has(name) && box !== "contents";
      const atomic = control || box === "atomic";
      // A box set through var(), which the check cannot follow, may end the
      // line at its edges or not, and an isolation set that way may hold its
      // content apart or not, though it parts no words.
      const unsure = box === "uncertain" ? UNSURE_BREAK : VARIABLE.test(style.get("unicode-bidi") ?? "") ? AMBIGUOUS : null;
      if (unsure) loose(unsure);
      if (hidden) unseen += 1;
      const unsureBox = box === "uncertain";
      if (unsureBox) unsureBoxes += 1;
      if (block) paragraph();
      // A form control sits apart from the words around it; an inline-level
      // block of ordinary text sits against them, as "1" and "00" make 100.
      // A control whose box comes through var() parts words only as its
      // uncertain edges do.
      if (atomic) {
        if (control && !unsureBox) loose(" ");
        parts.push(ATOMIC_START);
      }
      // What is not laid out reaches nothing around it either. A block or a
      // form control among what is hidden stands apart from the words around
      // it, as it does once opened, when it holds any text, which its end tells.
      else if (hidden) parts.push(ATOMIC_START);
      // So do a textarea and a select whose box comes through var(), which
      // hold their text apart whatever box it gives, as display: contents
      // hides them, and an option, which a dropdown shows on its own; a
      // button with display: contents lays its text out inline.
      const apartAt = hiddenBlock || (hidden && SEPARATED_ELEMENTS.has(name)) || (unsureBox && (name === "textarea" || name === "select" || name === "option")) ? parts.push("") - 1 : null;
      const preserves = name ? keepsLineBreaks(name, style) : null;
      if (preserves !== null) preserving.push(preserves);
      const frame = (name === "sup" || name === "sub") && raised.length < MAX_RAISE_DEPTH;
      if (frame) {
        raised.push({ name, at: parts.length });
        parts.push("");
      }
      // Whether the element sets its text's direction: a forced or a
      // content-decided order does, and so does an inline element's turn to a
      // direction other than the one it inherits. A page's own direction, on
      // its root, does not, nor does a block's, which is only the base its own
      // paragraphs are read in, as a page's is. A direction left to content not
      // yet read is an entry, resolved once the page is read, and so is any
      // comparison with one.
      const inherited = directions.at(-1) ?? "ltr";
      const root = name === "html" || name === "head" || name === "body";
      // A hidden block's direction is a base too, as it is once opened.
      const base = root || block || hiddenBlock;
      const { direction: named, bidi, reverted } = name ? directionOf(node, name, style, bidis.at(-1) ?? "normal") : { direction: null, bidi: "normal", reverted: false };
      // A dir that revert keeps in one engine and drops in another turns an
      // inline element's text as any dir does, and leaves a block's direction
      // unknown wherever it may differ from the one the block inherits.
      const declared = reverted && base && (named === "auto" || typeof inherited !== "string" || named !== inherited) ? "uncertain" : named;
      // A root's or a block's direction set through var() is the base its
      // paragraphs are read in, not known, which an element inside that names
      // its own then differs from.
      const direction = declared === "auto" ? { found: null } : declared === "uncertain" ? (base ? "uncertain" : null) : declared;
      let scope = null;
      // A forced or content-decided order sets a scope, and so does a value the
      // check cannot follow.
      if (bidi === "bidi-override" || bidi === "isolate-override" || bidi === "plaintext" || bidi === "uncertain" || (declared === "uncertain" && !base)) scope = true;
      else if (!base && direction && (typeof direction !== "string" || typeof inherited !== "string")) scope = { direction, inherited };
      else if (!base && direction && direction !== inherited) scope = true;
      const scopeAt = parts.length;
      parts.push("");
      if (direction) directions.push(direction);
      bidis.push(bidi);
      const dirAttribute = name ? node.attrs.find(({ name: attribute }) => attribute === "dir")?.value.toLowerCase() : undefined;
      const apart = name === "bdi" || name === "textarea" || dirAttribute === "ltr" || dirAttribute === "rtl" || dirAttribute === "auto";
      if (apart) autos.push(typeof direction === "object" && direction ? direction : null);
      const isolates = bidi === "isolate" || bidi === "isolate-override" || bidi === "plaintext";
      // A block's edges end its paragraph already, so only an inline element
      // needs the marks of its isolation, and a block among what is hidden,
      // whose edges end nothing.
      const marksIsolation = isolates && (!block || unseen > 0);
      if (marksIsolation) parts.push(ISOLATE_START);
      // A CSS embedding or override is, as CSS has it, the control Unicode's
      // algorithm would see at the element's edges, written into the text.
      const rtl = (direction ?? inherited) === "rtl";
      const embeds = bidi === "embed" ? (rtl ? "\u202b" : "\u202a") : bidi === "bidi-override" ? (rtl ? "\u202e" : "\u202d") : null;
      if (embeds) parts.push(embeds);
      pending.push({ closes: name, frame, scope, scopeAt, direction, marksIsolation, embeds, preserves, unseen: hidden, block, atomic, control, apart, unsure, unsureBox, apartAt, readAt: read, blankFrom: parts.length });
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) pending.push(node.childNodes[index]);
    }
  }
  // An auto direction with no strong character in its content is ltr, as HTML
  // has it, and each comparison that waited on one is made now.
  const resolved = (direction) => (typeof direction === "string" ? direction : direction.found ?? "ltr");
  for (const { direction, inherited, scopeAt, endAt, dropped } of deferred) {
    if (dropped || resolved(direction) === resolved(inherited)) continue;
    parts[scopeAt] = SCOPE_START;
    parts[endAt] = SCOPE_END;
  }
  const text = parts.join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  // The edges of what is laid out apart matter only where a control could
  // reach past one, so a page without controls keeps none.
  return DIRECTIONAL_CONTROLS.test(text) ? text : text.replace(/\uE004[\uE00d-\uE011]/g, "");
}

function pdfText(file) {
  // Without -layout, which interleaves the columns of a multi-column page.
  const result = spawnSync("pdftotext", ["-q", "-enc", "UTF-8", file, "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: PDF_TIMEOUT_MS });
  if (result.error?.code === "ENOENT") throw new SourceProblem("unreadable", "it is a PDF, and pdftotext is not installed to read it");
  if (result.error || result.status !== 0) throw new SourceProblem("unreadable", "it is a PDF that pdftotext could not read");
  return result.stdout;
}

function isPdf(bytes) {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

// The text of what was read, and whether it came out of a PDF. A PDF is
// converted from these bytes, so the text is always that of what was checked.
function textOf(bytes, { contentType = "" } = {}) {
  if (isPdf(bytes)) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cross-research-pdf-"));
    const temporary = path.join(directory, "source.pdf");
    try {
      fs.writeFileSync(temporary, bytes);
      return { text: escapeMarks(pdfText(temporary)), pdf: true };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  if (bytes.subarray(0, 8192).includes(0)) throw new SourceProblem("unreadable", "it is not text");
  const text = bytes.toString("utf8");
  const html = /html/i.test(contentType) || /^\s*(?:<!doctype html|<html[\s>])/i.test(text.slice(0, 2048));
  return { text: html ? htmlToText(text) : escapeMarks(text), pdf: false };
}

// Addresses that are this machine, its networks, or not routable at all. An
// IPv4 address written as IPv6 is judged by the IPv4 entries.
const NOT_PUBLIC = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3]
]) NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
// Several of these carry an IPv4 address inside them, which may be a private
// one: the IPv4-compatible and -translated forms, NAT64, Teredo, and 6to4.
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
]) NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

// This machine's own addresses, public ones included, since a service that
// listens on every interface answers on each of them.
function ownAddresses(interfaces) {
  const list = new net.BlockList();
  for (const entry of Object.values(interfaces).flat()) {
    const address = String(entry?.address ?? "").replace(/%.*$/, "");
    const family = net.isIP(address);
    if (family) list.addAddress(address, family === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

// `interfaces` stands in for this machine's, which only the tests replace.
export function privateAddress(address, interfaces = null) {
  const family = net.isIP(address);
  // What is not an address at all is not known to be public.
  if (family === 0) return true;
  const type = family === 6 ? "ipv6" : "ipv4";
  const own = ownAddresses(interfaces ?? os.networkInterfaces());
  return NOT_PUBLIC.check(address, type) || own.check(address, type);
}

// Resolves a name for the socket that is about to connect, and refuses an
// address that is not public. Checking here, and not before the request,
// leaves no moment in which the name can come to mean another address.
export function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    // This machine's addresses as they are now, read once for the whole answer.
    const interfaces = os.networkInterfaces();
    const local = addresses.find(({ address }) => privateAddress(address, interfaces));
    if (local) return callback(Object.assign(new Error(`${hostname} resolves to ${local.address}`), { code: "ENOTPUBLIC" }));
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const DECODERS = new Map([["gzip", zlib.createGunzip], ["x-gzip", zlib.createGunzip], ["deflate", zlib.createInflate], ["br", zlib.createBrotliDecompress]]);
// Requests go straight to the address the lookup approved. Node's global
// agents can send a request through a proxy named in the environment, which
// would resolve the cited name where no check here can see the answer.
const DIRECT = { "http:": new http.Agent(), "https:": new https.Agent() };

// One GET, with no redirect followed. Resolves to the status, the headers,
// and the decoded body, or rejects with the reason as a SourceProblem.
export function requestPage(url, { lookup = publicLookup } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      action(value);
    };
    const unreachable = (error) => settle(reject, new SourceProblem(
      "unreachable",
      error.code === "ENOTPUBLIC"
        ? PRIVATE_REFUSAL
        : `the request failed (${error.code ?? error.message})`
    ));
    let request;
    try {
      request = (url.protocol === "https:" ? https : http).request(url, {
        method: "GET",
        agent: DIRECT[url.protocol],
        lookup,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.8",
          "accept-encoding": "gzip, deflate, br"
        }
      });
    } catch (error) {
      // An address Node cannot turn into a request at all, such as one with malformed escapes.
      reject(new SourceProblem("unreachable", `the request could not be made (${error.message})`));
      return;
    }
    // One limit for the whole exchange, since a slow body is as stuck as a slow connection.
    const deadline = setTimeout(() => settle(reject, new SourceProblem("unreachable", `no complete answer in ${REQUEST_TIMEOUT_MS / 1000} seconds`)), REQUEST_TIMEOUT_MS);
    request.on("error", unreachable);
    request.on("response", (response) => {
      const status = response.statusCode;
      if (status >= 300 && status < 400 && response.headers.location) return settle(resolve, { status, location: response.headers.location });
      if (status < 200 || status >= 300) return settle(resolve, { status });
      const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
      if (encoding && encoding !== "identity" && !DECODERS.has(encoding)) {
        return settle(reject, new SourceProblem("unreadable", `it is encoded as ${JSON.stringify(encoding.slice(0, 40))}, which the check cannot decode`));
      }
      const body = DECODERS.has(encoding) ? response.pipe(DECODERS.get(encoding)()) : response;
      const chunks = [];
      let size = 0;
      response.on("error", unreachable);
      body.on("error", unreachable);
      body.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_SOURCE_BYTES) return settle(reject, new SourceProblem("unreadable", `it is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MB`));
        return chunks.push(chunk);
      });
      body.on("end", () => settle(resolve, { status, contentType: String(response.headers["content-type"] ?? ""), bytes: Buffer.concat(chunks) }));
      return undefined;
    });
    request.end();
  });
}

// GitHub renders a file's page in the browser, so the text is fetched raw.
export function fetchAddress(address) {
  const blob = address.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^?#]+)/);
  return blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}` : address;
}

async function fetchBytes(address, request) {
  let url;
  try {
    url = new URL(fetchAddress(address));
  } catch {
    throw new SourceProblem("unreadable", "it is not a valid address");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!["http:", "https:"].includes(url.protocol)) throw new SourceProblem("unreadable", `${url.protocol} addresses are not fetched`);
    if (url.username || url.password) throw new SourceProblem("unreadable", "an address that carries a user name or password is not fetched");
    // A literal address never reaches the lookup that refuses the others.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && privateAddress(host)) {
      throw new SourceProblem("unreachable", PRIVATE_REFUSAL);
    }
    const response = await request(url);
    if (response.location) {
      try {
        url = new URL(response.location, url);
      } catch {
        throw new SourceProblem("unreachable", "it redirected to an address that is not valid");
      }
      continue;
    }
    if (!response.bytes) throw new SourceProblem("unreachable", `the server answered HTTP ${response.status}`);
    return response;
  }
  throw new SourceProblem("unreachable", `it redirected more than ${MAX_REDIRECTS} times`);
}

// The names a researcher is told not to open, and those the review runtime
// keeps out of what it sends.
export function credentialName(file) {
  const name = path.basename(String(file));
  return likelySecretPath(name) || /^(?:\.env|credentials|secrets|token)/i.test(name) || /\.(?:pem|key)$/i.test(name);
}

// A file a researcher read: in the repository, which holds what it
// downloaded too. Nothing else on the machine is opened on the word of a
// researcher's output, and neither is a file that looks like a credential,
// which a researcher is told not to open in the first place.
function fileText(file, { repoRoot, roots }) {
  const named = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  // Researchers sometimes append a line reference to the path.
  const candidate = fs.existsSync(named) ? named : named.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new SourceProblem("unreachable", "there is no such file");
  }
  if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
    throw new SourceProblem("unreadable", "it is outside the repository, so the check does not open it");
  }
  if (credentialName(candidate) || credentialName(real)) {
    throw new SourceProblem("unreadable", "it is named like a credential file, which the check does not open");
  }
  // Read through one descriptor that is then shown to be the file approved
  // above, so that a path swapped for another meanwhile is never followed.
  let descriptor;
  try {
    // Without waiting, so that a named pipe is refused below and not read from.
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") throw new SourceProblem("unreachable", "there is no such file");
    throw new SourceProblem("unreadable", `it could not be opened (${error.code ?? error.message})`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new SourceProblem("unreadable", "it is not a file");
    if (stat.size > MAX_SOURCE_BYTES) throw new SourceProblem("unreadable", `it is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MB`);
    const after = fs.existsSync(candidate) ? fs.realpathSync(candidate) : null;
    const current = after === real ? fs.statSync(after) : null;
    if (!current || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new SourceProblem("unreadable", "it changed while the check was opening it");
    }
    return textOf(fs.readFileSync(descriptor));
  } finally {
    fs.closeSync(descriptor);
  }
}

// The text kept from an earlier check, or null when there is none to read,
// such as when the directory cannot be read or is not a directory at all, in
// which case the page is fetched again.
function keptText(file) {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

// The text of a web source, kept so that a second check costs no request and
// the agent can read what the quote was tested against. The caller keeps it
// where no sandboxed researcher can write, since the check reads and writes
// there with the user's own privileges. A kept text is still read only if it
// is a regular file, and replaced by renaming, so a link is never followed.
// A page's kept texts are in a directory of its own, each named by the
// versions that read it and by its content, so that no fetch changes a text
// a report names. Its "current" file names the text the last fetch kept.
const SNAPSHOT = /^(v\d+\.u[\d.]+)-[0-9a-f]{16}(\.pdf)?\.txt$/;

// The text the last fetch of a page kept, as { file, version, pdf }, or null.
// Kept text only saves a request, so a record that cannot be read, or names
// anything but a kept text beside it, keeps nothing.
// Why a page's directory of kept texts cannot be used, or null when it is
// missing, to be made, or a real directory. Anything else, a link included,
// keeps nothing, and a lookup that fails says why.
function keptDirectoryProblem(directory) {
  let stat;
  try {
    stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  } catch (error) {
    return error.code ?? error.message;
  }
  return !stat || stat.isDirectory() ? null : "its directory of kept texts is not a directory";
}

function currentKept(directory) {
  const record = keptText(path.join(directory, "current"));
  if (record === null) return null;
  let current;
  try {
    current = JSON.parse(record);
  } catch {
    return null;
  }
  const parsed = typeof current?.file === "string" ? SNAPSHOT.exec(current.file) : null;
  return parsed ? { file: path.join(directory, current.file), version: parsed[1], pdf: Boolean(parsed[2]) } : null;
}

async function urlText(address, { cacheDirectory, refresh, request }) {
  const name = crypto.createHash("sha256").update(address).digest("hex").slice(0, 16);
  // Which characters count as digits, or fold to others, follows the Unicode
  // version of the Node.js that read the page, so it names the text too.
  const version = `v${TEXT_FORMAT}.u${process.versions.unicode}`;
  const directory = path.join(cacheDirectory, name);
  // Kept texts are read and written only in a real directory, so that no link
  // lets two pages share them.
  const usable = keptDirectoryProblem(directory) === null;
  // Reused only if the last fetch kept it and this version read it; a page
  // that another version fetched since is fetched again.
  const current = refresh || !usable ? null : currentKept(directory);
  if (current?.version === version) {
    const saved = keptText(current.file);
    if (saved !== null) return { text: saved, pdf: current.pdf, cache: current.file };
  }
  const { bytes, contentType } = await fetchBytes(address, request);
  const { text, pdf } = textOf(bytes, { contentType });
  const digest = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const snapshot = `${version}-${digest}${pdf ? ".pdf" : ""}.txt`;
  const cache = path.join(directory, snapshot);
  // Asked again, since the directory may have changed during the fetch.
  const problem = keptDirectoryProblem(directory);
  if (problem) return { text, pdf, cache: null, cacheError: problem };
  try {
    atomicWriteText(cache, text);
  } catch (error) {
    // The page was read, so its quotes are checked all the same; only keeping
    // its text failed, which the report says.
    return { text, pdf, cache: null, cacheError: error.code ?? error.message };
  }
  try {
    atomicWriteText(path.join(directory, "current"), `${JSON.stringify({ file: snapshot })}\n`);
  } catch (error) {
    // The text is kept, and the report names it, but a later check cannot
    // tell it is the newest.
    return { text, pdf, cache, cacheError: error.code ?? error.message };
  }
  return { text, pdf, cache };
}

async function pooled(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Each entry is { url, file, quote } plus whatever the caller wants back.
// Returns the entries with status, detail, and the kept text's path.
// `cacheDirectory` is where fetched pages are kept, and `request` is how a
// page is requested, which only the tests replace. Files are opened only in
// the repository, whose real path is the one root, so a directory in it that
// links elsewhere leads nowhere the check will read.
export async function checkSources(entries, { repoRoot, cacheDirectory, refresh = false, request = requestPage }) {
  const roots = [fs.realpathSync(repoRoot)];
  // One load per location, however many quotes cite it.
  const loads = new Map();
  const load = (entry) => {
    const key = entry.url ? `url ${entry.url}` : `file ${entry.file}`;
    if (!loads.has(key)) {
      const loading = (entry.url
        ? urlText(entry.url, { cacheDirectory, refresh, request })
        : Promise.resolve().then(() => ({ ...fileText(entry.file, { repoRoot, roots }), cache: null }))
      ).then(({ text, pdf, cache, cacheError = null }) => ({ text: searchable({ text, pdf }), cache, cacheError }));
      // A source that cannot be read is an outcome to report, not a failure of
      // the check, whatever went wrong with it: the other sources still count.
      loads.set(key, loading.catch((error) => ({
        problem: error instanceof SourceProblem ? error : new SourceProblem(entry.url ? "unreachable" : "unreadable", `reading it failed (${error.message})`)
      })));
    }
    return loads.get(key);
  };
  return pooled(entries, CONCURRENCY, async (entry) => {
    if (!entry.url && !entry.file) return { ...entry, status: "unreadable", detail: "it names neither a url nor a file", cache: null };
    const loaded = await load(entry);
    if (loaded.problem) return { ...entry, status: loaded.problem.status, detail: loaded.problem.message, cache: null };
    return { ...entry, ...matchSearchable(loaded.text, entry.quote), cache: loaded.cache, cache_error: loaded.cacheError };
  });
}
