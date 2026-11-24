// The idempotency key of a work request the visitor confirmed, kept in the tab (sessionStorage) under a
// draft id, so a double click, a second widget on the page, a retry and a reload of a submit in flight
// all send the same key. Only the key and when it was minted are stored: never the contact value, the
// purpose or anything else the visitor typed. A new intent gets a new key; a key is never derived from
// the conversation.
import { WORK_REQUEST_KEY_RE } from "../work-request";

const PREFIX = "dewee-webchat:wr-draft:";
/** A draft older than this is forgotten: its request was found, refused or abandoned long ago. */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60_000;

export interface WorkRequestDraft {
  key: string;
  /** When the key was minted (browser time). */
  at: number;
}

const tab = {
  get(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked: the key lives in memory only */ } },
  del(k: string) { try { sessionStorage.removeItem(k); } catch { /* storage blocked */ } },
  keys(): string[] {
    try {
      const out: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) out.push(sessionStorage.key(i) ?? "");
      return out;
    } catch { return []; }
  },
};

/** The draft id of a kind sent to a backend: one intent per kind at a time. */
export function draftId(endpoint: string, kind: string): string {
  return `${PREFIX}${endpoint}|${kind}`;
}

/** A new crypto-random key (`wr-` and 24 URL-safe characters). */
export function mintKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  return "wr-" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => alphabet[b & 63]).join("");
}

export function readDraft(id: string): WorkRequestDraft | null {
  const raw = tab.get(id);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<WorkRequestDraft>;
    if (typeof d.key === "string" && WORK_REQUEST_KEY_RE.test(d.key) && typeof d.at === "number" && Date.now() - d.at < DRAFT_MAX_AGE_MS) return { key: d.key, at: d.at };
  } catch { /* corrupted entry */ }
  tab.del(id);
  return null;
}

/** The key of the draft in progress for `id`, or a new one, stored before anything is sent. */
export function claimKey(id: string): string {
  const existing = readDraft(id);
  if (existing) return existing.key;
  const key = mintKey();
  tab.set(id, JSON.stringify({ key, at: Date.now() } satisfies WorkRequestDraft));
  return key;
}

/** Forgets the draft, unless it already holds another key (a newer intent of another widget on the page). */
export function dropDraft(id: string, key: string): void {
  if (readDraft(id)?.key === key) tab.del(id);
}

/** The drafts of a backend still in the tab, with their kinds. */
export function draftsFor(endpoint: string): Array<{ id: string; kind: string; draft: WorkRequestDraft }> {
  const head = `${PREFIX}${endpoint}|`;
  const out: Array<{ id: string; kind: string; draft: WorkRequestDraft }> = [];
  for (const id of tab.keys()) {
    if (!id.startsWith(head)) continue;
    const draft = readDraft(id);
    if (draft) out.push({ id, kind: id.slice(head.length), draft });
  }
  return out;
}
