// Page actions, browser side: the agent calls an action by ending its answer with a fenced
// ```dewee-action block holding {"id","name","args"}; the widget answers with ```dewee-action-result
// blocks. Agent output is untrusted: parsing is bounded and never evaluates anything.

export const DIRECTIVE_LANG = "dewee-action";
export const RESULT_LANG = "dewee-action-result";
export const DIRECTIVE_LIMITS = { maxCalls: 8, maxBlockBytes: 8192 } as const;

const CALL_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const FENCE_CLOSE_RE = /^\s{0,3}```\s*$/;
const fenceOpen = (lang: string) => new RegExp("^\\s{0,3}```" + lang.replace(/[.-]/g, "\\$&") + "\\s*$");
const DIRECTIVE_OPEN_RE = fenceOpen(DIRECTIVE_LANG);
const RESULT_OPEN_RE = fenceOpen(RESULT_LANG);

export type ParsedCall =
  | { ok: true; id: string; name: string; args: Record<string, unknown> }
  | { ok: false; id: string; name: string; error: string };

export interface ParsedDirectives {
  /** Answer text with every directive block removed (what the visitor sees). */
  text: string;
  calls: ParsedCall[];
}

export type ActionResultStatus = "ok" | "denied" | "error";
export interface ActionResult {
  id: string;
  name: string;
  status: ActionResultStatus;
  result?: unknown;
  error?: string;
}

interface Block { start: number; end: number; body: string[]; closed: boolean }

function findBlocks(lines: string[], open: RegExp): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!open.test(lines[i])) continue;
    const start = i;
    const body: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (FENCE_CLOSE_RE.test(lines[i])) { closed = true; break; }
      body.push(lines[i]);
    }
    blocks.push({ start, end: Math.min(i, lines.length - 1), body, closed });
  }
  return blocks;
}

const removeBlocks = (lines: string[], blocks: Block[]) => {
  const drop = new Set<number>();
  for (const b of blocks) for (let i = b.start; i <= b.end; i++) drop.add(i);
  return lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Extracts action calls from an answer. Malformed, oversized, unclosed or surplus blocks become
 * `ok: false` entries so the agent gets an error result instead of silence.
 */
export function parseDirectives(content: string): ParsedDirectives {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks = findBlocks(lines, DIRECTIVE_OPEN_RE);
  const calls: ParsedCall[] = [];
  const ids = new Set<string>();
  blocks.forEach((b, n) => {
    const fallbackId = `call-${n + 1}`;
    const raw = b.body.join("\n");
    const bad = (error: string, id = fallbackId, name = "") => calls.push({ ok: false, id, name, error });
    if (n >= DIRECTIVE_LIMITS.maxCalls) return bad(`Too many action calls in one reply (max ${DIRECTIVE_LIMITS.maxCalls})`);
    if (!b.closed) return bad("Unclosed dewee-action block");
    if (new TextEncoder().encode(raw).length > DIRECTIVE_LIMITS.maxBlockBytes) return bad(`Action block exceeds ${DIRECTIVE_LIMITS.maxBlockBytes} bytes`);
    let data: any;
    try { data = JSON.parse(raw); } catch { return bad("Action block is not valid JSON"); }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return bad("Action block must be a JSON object");
    let id = typeof data.id === "string" && CALL_ID_RE.test(data.id) ? data.id : fallbackId;
    const name = typeof data.name === "string" ? data.name.slice(0, 64) : "";
    if (ids.has(id)) return bad(`Duplicate action call id "${id}"`, `${id}-${n + 1}`, name);
    ids.add(id);
    if (!name) return bad("Action name is required", id);
    const args = data.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return bad("args must be a JSON object", id, name);
    calls.push({ ok: true, id, name, args });
  });
  return { text: blocks.length ? removeBlocks(lines, blocks) : content, calls };
}

/** Display text while streaming: hides finished blocks and a trailing block that is still open. */
export function stripDirectives(content: string): string {
  if (!content.includes("```" + DIRECTIVE_LANG)) return content;
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  return removeBlocks(lines, findBlocks(lines, DIRECTIVE_OPEN_RE));
}

/** True when a user message is an automatic action-result follow-up (hidden in the transcript). */
export function isActionResultMessage(content: string): boolean {
  return /^\s*```dewee-action-result(?:\s|$)/.test(content);
}

/** Extract compact result objects without confusing fences inside JSON strings for the closing fence. */
function compactResultBodies(content: string): string[] {
  const open = /```dewee-action-result\s+/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = open.exec(content))) {
    const start = open.lastIndex;
    if (content[start] !== "{") continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < content.length; i++) {
      const c = content[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const close = /^\s*```/.exec(content.slice(i + 1));
        if (close) {
          bodies.push(content.slice(start, i + 1));
          open.lastIndex = i + 1 + close[0].length;
        }
        break;
      }
    }
  }
  return bodies;
}

/** Reads results back from an action-result message (history rendering). */
export function parseActionResults(content: string): ActionResult[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const out: ActionResult[] = [];
  const blocks = findBlocks(lines, RESULT_OPEN_RE);
  // Accept compact history fences while preserving the original multi-line parser.
  const bodies = blocks.length ? blocks.map((b) => b.body.join("\n")) :
    compactResultBodies(content);
  for (const body of bodies) {
    try {
      const r = JSON.parse(body);
      if (r && typeof r.id === "string" && ["ok", "denied", "error"].includes(r.status)) out.push(r as ActionResult);
    } catch { /* ignore */ }
  }
  return out;
}

const block = (r: ActionResult) => "```" + RESULT_LANG + "\n" + JSON.stringify(r) + "\n```";

/**
 * Formats results as the follow-up message, shrinking oversized results so the whole message
 * stays within the backend's `maxMessageLength`.
 */
export function formatActionResults(results: ActionResult[], maxLength = 4000): string {
  const budget = Math.max(64, Math.floor((maxLength - 16) / Math.max(1, results.length)));
  const fitted = results.map((r) => {
    const safe: ActionResult = { ...r, result: toJsonValue(r.result) };
    if (safe.result === undefined) delete safe.result;
    if (block(safe).length <= budget) return block(safe);
    const preview = JSON.stringify(safe.result ?? null);
    const room = budget - block({ ...safe, result: { truncated: true, preview: "" } }).length - 8;
    const shrunk = block({ ...safe, result: { truncated: true, preview: preview.slice(0, Math.max(0, room)) } });
    return shrunk.length <= budget ? shrunk : block({ id: r.id, name: r.name.slice(0, 64), status: r.status, result: { truncated: true } });
  });
  return fitted.join("\n\n").slice(0, maxLength);
}

/** Converts a handler return value into plain JSON (drops functions, cycles become an error string). */
export function toJsonValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? null : JSON.parse(s);
  } catch {
    return "[unserializable result]";
  }
}
