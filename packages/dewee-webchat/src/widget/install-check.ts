// The control plane's install check, page side: the nonce in the page URL (`?dewee_check=`) is read
// once per page load and removed from the address bar at once, so it does not travel on in links,
// `Referer`, analytics, page context or page-action results. A nonce whose test message was sent is
// remembered for the tab as a SHA-256 hash (never the nonce), so a reload or back-navigation with the
// same link never sends it twice.
import { INSTALL_CHECK_PARAM, INSTALL_CHECK_RE } from "../protocol";

const USED_KEY = "dewee-webchat:install-checks";
/** How many used nonces a tab remembers. */
const MAX_USED = 20;

let pageNonce: string | null | undefined;
/** Used nonces (hashes, or the nonce itself when it cannot be hashed) when `sessionStorage` is unavailable. */
const usedInMemory = new Set<string>();

/**
 * The page URL's install check nonce, read once per page load, or null (none, or malformed). Any
 * `dewee_check` parameter is removed from the address bar, keeping the path, the other parameters, the
 * hash and the history state.
 */
export function pageInstallCheck(): string | null {
  if (pageNonce !== undefined) return pageNonce;
  pageNonce = null;
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(INSTALL_CHECK_PARAM)) return pageNonce;
    const value = url.searchParams.get(INSTALL_CHECK_PARAM);
    pageNonce = value !== null && INSTALL_CHECK_RE.test(value) ? value : null;
    url.searchParams.delete(INSTALL_CHECK_PARAM);
    if (typeof history !== "undefined" && typeof history.replaceState === "function") history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* no location or history (a sandboxed frame): the nonce read so far stands */
  }
  return pageNonce;
}

/** A hex SHA-256 of the nonce, or null when the page has no Web Crypto (an insecure context). */
async function hashOf(nonce: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`dewee-webchat:install-check:${nonce}`));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function storedHashes(): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(USED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/** Whether this tab already sent the test message for this nonce. */
export async function installCheckUsed(nonce: string): Promise<boolean> {
  const hash = await hashOf(nonce);
  if (hash === null) return usedInMemory.has(nonce);
  return usedInMemory.has(hash) || storedHashes().includes(hash);
}

/** Remembers that the test message for this nonce was handed to the send path. Never stores the nonce. */
export async function markInstallCheckUsed(nonce: string): Promise<void> {
  const hash = await hashOf(nonce);
  if (hash === null) {
    usedInMemory.add(nonce);
    return;
  }
  usedInMemory.add(hash);
  try {
    sessionStorage.setItem(USED_KEY, JSON.stringify([...storedHashes().filter((h) => h !== hash), hash].slice(-MAX_USED)));
  } catch {
    /* storage blocked: remembered for this page load only */
  }
}

/** One check per page load: `running` while a widget runs it, `done` once it settled. */
let run: "idle" | "running" | "done" = "idle";

/** Claims the page load's check for one widget; false while another runs it or once it settled. */
export function beginInstallCheckRun(): boolean {
  if (run !== "idle") return false;
  run = "running";
  return true;
}

/** Ends a run: `settled` when the check is over for this page load, else it is left to the next boot. */
export function endInstallCheckRun(settled: boolean): void {
  run = settled ? "done" : "idle";
}

/** Test hook: a new page load (the nonce is read again and the check may run again). */
export function resetPageInstallCheck(): void {
  pageNonce = undefined;
  run = "idle";
}
