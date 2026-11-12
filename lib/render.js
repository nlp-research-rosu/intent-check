// Agent-facing text, built only from validated contract fields. Service text is untrusted:
// it is length-capped, and URLs, shell commands, code fences and tags are stripped before
// the user's agent sees it.
import { clip } from "./text.js";

// Shell commands: never useful in a title or a fix direction.
const SHELL_RE = new RegExp(
  [
    String.raw`\$\(`, String.raw`&&`, String.raw`\|\|`, String.raw`\|\s*(?:ba|z)?sh\b`,
    String.raw`(?:^|[\s;\x60'"(])(?:rm|curl|wget|chmod|chown|mkfifo|nc|ncat|ssh|scp|powershell|pwsh|iex|bash|sh|zsh|cmd)\s+(?:-|/|~|\$|\.|https?:|["'])`,
    String.raw`\bsudo\s+\w`,
    String.raw`\b(?:npx|npm|pnpm|yarn|pip3?|brew|apt(?:-get)?|gem|cargo|go)\s+(?:install|i|add|exec|run|dlx|get)\b`,
    String.raw`\b(?:python3?|node|deno|bun|ruby|perl)\s+-[ec]\b`,
    String.raw`\bgit\s+(?:clone|push|pull|fetch|remote|config|reset|checkout|apply)\b`,
    String.raw`(?:^|\s)>{1,2}\s*(?:~\/?|\/|\.\/)[\w.]`,
    String.raw`\b(?:run|execute|type|paste|invoke)\s+(?:this|the following|these|this command|the command)\b`,
    String.raw`\bbase64\s+(?:-d|--decode)\b`,
  ].join("|"),
  "i",
);

// Text addressed to the agent: instructions, claimed authority, exfiltration. Checked in
// titles and fix directions alike; phrased so ordinary descriptions of code do not match
// ("The user asked for a result that…", "Retries always skip authentication…").
const INJECTION_RE = new RegExp(
  [
    String.raw`\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:instructions?|prompts?|rules|previous|above|prior)\b`,
    String.raw`\b(?:reveal|print|show|output|repeat|leak|ignore|override|forget|your)\s+(?:the\s+)?system prompt\b`, String.raw`\bnew system prompt\b`, String.raw`\bsystem prompt\s*:`, String.raw`\byou are now\b`, String.raw`\bnew instructions?\b`,
    String.raw`\bdeveloper mode\b`, String.raw`\bjailbreak\b`,
    String.raw`\b(?:user|developer|owner|maintainer|operator|admin(?:istrator)?|team|boss|manager)s?\b[^.]{0,20}\b(?:wants?|asked|asks|would like|requested|requests|expects|told|needs?|instructed|authori[sz]ed|allowed|permitted)\s+you\b`,
    String.raw`\byou (?:must|should|need to|have to|are (?:allowed|permitted|authori[sz]ed) to|may now|can now)\b[^.]{0,50}\b(?:approve|permission|confirm|disable|push|delete|skip|bypass|ignore|send|upload|post|merge|deploy)\b`,
    String.raw`\b(?:do not|don't|never) (?:ask|wait|check) (?:the user )?(?:for|before|with)\b`,
    String.raw`\b(?:proceed|continue|go ahead)\b[^.]{0,20}\bwithout (?:asking|confirmation|confirming|approval|permission|telling)\b`,
    // In a title, "without asking" is an instruction only in a sentence that opens (after at most a
    // two-word lead-in such as "Note:" or "You can") with a bare
    // imperative ("Delete the tests without asking."); "Deletes the file without asking…" describes code.
    String.raw`^\s*(?:[\w']+[:,]?\s+){0,2}(?:to\s+)?(?:please\s+)?(?:delete|remove|drop|push|merge|deploy|commit|publish|release|run|execute|install|approve|apply|disable|overwrite|force|reset|revert|rewrite|send|upload|post|grant|give|change|edit|modify|update|write|create|rename|move|proceed|continue|go ahead|do it)\b[^.]{0,120}\bwithout (?:asking|confirmation|confirming|approval|permission|telling)\b`,
    String.raw`\bfrom now on,?\s+(?:you|always|never|do|don't|ignore|skip|approve)\b`,
    String.raw`\balways (?:approve|accept|allow|say yes)\b`,
    String.raw`^\s*(?:please\s+)?(?:post|send|upload|paste|share|copy|exfiltrate|cat|print|read out|email)\b[^.]{0,60}(?:~/|\.ssh|\.aws|\.env\b|id_rsa|credentials|secrets?\b|private keys?|api keys?|tokens?\b|passwords?)`,
  ].join("|"),
  "i",
);
// Squashed forms catch words split by spaces, dots or dashes ("ig nore", "i.g.n.o.r.e").
const SQUASHED_RE = /(?:ignore|disregard|forget)(?:all|any)?(?:the)?(?:previous|prior|above)(?:instructions|rules|prompts)|developermode|youarenow/;

// Fix directions are imperative text for the agent, so they get stricter rules on top.
const FIX_ONLY_RE = new RegExp(
  [
    String.raw`\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b`,
    String.raw`\]\(|\b(?:https?|ftp|file|data|javascript):|\bwww\.`, // links: a fix direction never needs one
    String.raw`\b(?:eval|exec|execSync|spawn|atob|Function|system|popen|fromCharCode)\s*\(`,
    String.raw`\b(?:user|developer|owner|maintainer|operator)s?\b[^.]{0,20}\b(?:has |have |already )?(?:authori[sz]ed|approved|allowed|permitted)\b`,
    String.raw`\b(?:disable|turn off|bypass)\b[^.]{0,30}\b(?:auth\w*|security|sandbox|permissions?|intent prover|hooks?|approvals?)\b`,
    String.raw`\b(?:always|never)\b[^.]{0,60}\b(?:approve|permissions?|confirm|ask(?:ing)?)\b`,
    String.raw`\bwithout (?:asking|confirmation|confirming|approval|permission|telling)\b`, // fix text is imperative
  ].join("|"),
  "i",
);

// Invisible and direction-control characters are removed (not spaced) before any check, so
// "Ig\u200bnore" cannot slip past the patterns. For the checks only, text is also folded to a
// skeleton: combining marks removed, lookalike Cyrillic/Greek letters and small caps mapped to Latin.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const LOOKALIKE = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ɡ": "g",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ο": "o", "ε": "e", "ι": "i", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "κ": "k", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ғ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z" };
const skeleton = (t) => t.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] || c);
// A word mixing Latin letters with lookalike letters ("Іgnore"). Real symbols such as µ or Δ
// are not lookalikes, so "500µs" and "The Δt value" pass.
const lookalikeWord = (t) => t.split(/\s+/).some((w) => /[A-Za-z]/.test(w) && [...w].some((c) => LOOKALIKE[c]));
const TAGGED = /<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g;
// Generic type syntax (Promise<void>, Map<string, number>, Vec<Option<T>>) is not a tag: "<" right
// after an identifier character, and type-like arguments only (Uppercase names, primitives, lifetimes,
// "?", "_", nested generics), none of them a tag or role word.
const PRIM = "string|number|boolean|void|any|unknown|never|null|undefined|object|bigint|symbol|int|long|short|byte|char|float|double|bool|str|usize|isize|u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|f32|f64";
const TYPE = String.raw`(?:(?:[A-Za-z_]\w*\.)*[A-Z]\w*|(?:${PRIM})(?!\w))`;
const BASE = String.raw`(?:${TYPE}|'\w+|_(?!\w)|\?(?:\s+(?:extends|super)\s+${TYPE})?)`;
// list(d): type arguments with nesting depth d, so GEN accepts three levels (Vec<Vec<Vec<T>>>).
const list = (d) => { const item = `${BASE}${d ? `(?:<${list(d - 1)}>)?` : ""}(?:\\[\\])*\\*?`; return `${item}(?:\\s*[,|&]\\s*${item})*`; };
// The lookahead bounds each attempt: a generic must show a "<" or ">" within 120 characters, else it is not tried.
const GEN = `(?=<[^<>]{1,120}[<>])<${list(2)}>`;
const NOT_TAG = new Set("system instructions instruction ignore important note warning critical override command commands rule rules policy secret thinking reasoning scratchpad example examples assistant human user tool tool_result tool_use function_calls function_results invoke parameter prompt context document documents message messages reminder admin developer script style img iframe svg a b i u s p div span".split(" "));
const ACRONYMS = new Set("URL URI UUID JSON HTML XML API DTO HTTP SQL CSV DOM".split(" "));
// Words are split on "_" too; an all-caps word of 3+ characters is a tag-like shout unless it is a known acronym.
const isGeneric = (g) => !(g.replace(/'\w+/g, "").match(/[A-Za-z0-9]+/g) || []).some((w) => NOT_TAG.has(w.toLowerCase()) || (/^[A-Z][A-Z0-9]{2,}$/.test(w) && !ACRONYMS.has(w)));
const GENERIC = new RegExp(`(?<=\\w)${GEN}`, "g");
// Cheap guard before the big patterns: every generic contains an innermost one with no "<" or ">" inside.
const maybeGen = (t) => /\w<[^<>]{1,120}>/.test(t);
const noGenerics = (t) => !maybeGen(t) ? t : t.replace(GENERIC, (g) => (isGeneric(g) ? "" : g));
const hasTag = (t) => /<\/?[A-Za-z!]/.test(noGenerics(t));
// Tags are stripped (or defanged with a space) except where a generic matches first.
const TAGS = new RegExp(`(?<=\\w)(${GEN})|<\\/?[A-Za-z][^>]{0,200}>`, "g");
const DEFANG = new RegExp(`(?<=\\w)(${GEN})|<(\\/?[A-Za-z!])`, "g");
const TAGS_PLAIN = /<\/?[A-Za-z][^>]{0,200}>/g;
const DEFANG_PLAIN = /<(\/?[A-Za-z!])/g;

function unsafe(t, kind) {
  const sk = skeleton(t);
  if (SHELL_RE.test(sk) || INJECTION_RE.test(sk)) return true;
  if (SQUASHED_RE.test(sk.toLowerCase().replace(/[^a-z]/g, ""))) return true;
  return kind === "fix" && (FIX_ONLY_RE.test(sk) || lookalikeWord(t));
}

// Links, addresses and tags; applied to whole text and to each inline code span.
function stripLinks(s) {
  return s
    .replace(maybeGen(s) ? TAGS : TAGS_PLAIN, (m, g) => (g && isGeneric(g) ? m : " "))
    .replace(/!?\[[^\]]{0,200}\]\([^)]{0,500}\)/g, " ") // markdown links and images, text and all
    .replace(/\b(?:https?|ftp|file|data|javascript|vbscript|ssh|git):\/{0,2}[^\s)]+/gi, " ")
    .replace(/\bwww\.[^\s)]+/gi, " ")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|ru|xyz|ly|gg)(?![\w-])(?:\/[^\s)]*)?/gi, " ");
}

// A closed one-line span of at most 120 characters survives if it is safe and has nothing to strip;
// identifier spans lose their backticks, others keep them. Unclosed or other spans become a space.
function codeSpan(m, code, kind) {
  // Spans get the strict "fix" rules whatever the kind, and must not look like payloads or tag pieces.
  if (code === undefined || !code.trim() || code.length > 120 || unsafe(code, "fix") || stripLinks(code) !== code) return " ";
  if (/^[A-Za-z0-9+/=_-]{20,}$/.test(code) && (/\d/.test(code) || code.endsWith("="))) return " "; // opaque payload
  if (/\[\.\]|\(\.\)|\[dot\]/i.test(code)) return " "; // defanged host
  const bare = noGenerics(code);
  if (/<\/?(?:[A-Za-z!]|$)/.test(bare) || /^\/?[A-Za-z][\w-]*>/.test(bare)) return " "; // tag fragment
  return /^[A-Za-z_][\w.]*(?:\(\))?$/.test(code) ? code : m;
}

const defang = (t) => t.replace(maybeGen(t) ? DEFANG : DEFANG_PLAIN, (m, g, tag) => (g ? (isGeneric(g) ? m : `< ${m.slice(1)}`) : `< ${tag}`));

function stripMarkup(s, kind) {
  return defang(stripLinks(String(s)
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`([^`\n]*)`|`[^`]*`?/g, (m, code) => codeSpan(m, code, kind)))
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cap(s, n) {
  if (s.length <= n) return s;
  const cut = clip(s, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

// Checked as written and with backticks removed or spaced, so a command or tag split across code
// spans (rm `-rf` /, <`system`>) cannot get past.
const sound = (t, kind) => !(hasTag(t) || hasTag(t.replace(/`/g, "")) || unsafe(t, kind) || unsafe(t.replace(/`/g, " "), kind));

// Remove sentences that carry commands or instructions to the agent. kind "title" is a
// description of the problem and only loses text addressed to the agent; kind "fix" (the
// default) is imperative and also loses addresses, exec()-style calls and lookalike words.
export function sanitize(text, max, kind = "fix") {
  if (typeof text !== "string") return "";
  // Normalise first (NFKC, invisible characters removed), then drop whole tagged regions.
  const raw = clip(text, 4000).normalize("NFKC").replace(INVISIBLE, "").replace(TAGGED, "\n");
  // Sentence split on the raw text so a command spread over a fence still drops its sentence.
  const kept = [];
  for (const sentence of raw.split(/(?<=[.!?])\s+|\n+/)) {
    if (!sound(sentence, kind)) continue;
    const clean = stripMarkup(sentence, kind);
    if (clean && sound(clean, kind)) kept.push(clean);
  }
  return cap(kept.join(" ").replace(/\s+/g, " ").trim(), max);
}
