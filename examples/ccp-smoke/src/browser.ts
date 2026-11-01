// What a browser sends to and receives from a host. Every response body and header is kept, so a
// test can check at the end that no secret ever reached the browser side.
import type { ChatStreamEvent } from "dewee-webchat";

export interface Answer {
  status: number;
  headers: Headers;
  text: string;
  json(): any;
}

export interface Browser {
  /** Everything the host answered so far. */
  received: string[];
  request(path: string, init?: { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string | null; ip?: string; headers?: Record<string, string> }): Promise<Answer>;
}

let ipCounter = 0;
/** A distinct client address (TEST-NET-3), so per-IP limits of one check do not affect another. */
export const nextIp = () => `203.0.113.${(++ipCounter % 250) + 1}`;

/**
 * `origin`: the Origin header; defaults to the host's own (a same-origin page). `null` sends none.
 * Requests carry an `x-forwarded-for` address: `ip`, or one fixed per browser.
 */
export function browser(hostOrigin: string, defaults: { origin?: string } = {}): Browser {
  const received: string[] = [];
  const ip = nextIp();
  return {
    received,
    async request(path, init = {}) {
      const headers: Record<string, string> = { "x-forwarded-for": init.ip ?? ip, ...init.headers };
      const origin = init.origin === undefined ? (defaults.origin ?? hostOrigin) : init.origin;
      if (origin) headers.origin = origin;
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      if (init.cookie) headers.cookie = init.cookie;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${hostOrigin}${path}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        redirect: "manual",
      });
      const text = await res.text();
      received.push(text, JSON.stringify([...res.headers]));
      return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
    },
  };
}

export const sseEvents = (text: string): ChatStreamEvent[] =>
  text
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => JSON.parse(f.slice(5)));

/** The scripts a page loads: inline ones and the same-origin files it references. */
export async function servedScripts(hostOrigin: string, path = "/"): Promise<string[]> {
  const html = await (await fetch(`${hostOrigin}${path}`)).text();
  const out = [html];
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    const url = new URL(m[1], hostOrigin);
    if (url.origin === hostOrigin) out.push(await (await fetch(url)).text());
  }
  return out;
}
