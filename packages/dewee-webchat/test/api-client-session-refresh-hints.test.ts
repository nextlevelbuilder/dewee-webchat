// @vitest-environment happy-dom
// How the browser client sizes its /session refreshes from the backend's refresh hint (`expiresIn`)
// carries the tab's signed-in reuse hint (`reuseHint`, never the bearer token) across page loads, and
// refreshes a returning visitor without a Turnstile challenge when the backend allows it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, defineDeweeChat, type DeweeChatElement } from "../src/index";

const jsonRes = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const HINT_KEY = "dewee-webchat:reuse:/api/dewee";

type SessionAnswer = (n: number) => Response;

/** A backend recording each /session body; `answer` decides each /session response. */
function backend(identity: boolean, answer: SessionAnswer, extraConfig: Record<string, unknown> = {}) {
  const bodies: Array<Record<string, string>> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), "https://site.test").pathname.replace("/api/dewee/", "");
    if (path === "config") return jsonRes(200, { agents: [{ id: "shop" }], defaultAgent: "shop", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test", ...(identity ? { identity: true } : {}), ...extraConfig });
    if (path === "session") {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return answer(bodies.length);
    }
    if (path === "chat" && String((init?.headers as Record<string, string>)?.authorization).endsWith("revoked")) return jsonRes(401, { error: { code: "LINK_REVOKED", message: "revoked" } });
    return new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return { bodies, fetch: fetchImpl as unknown as typeof fetch };
}

const page = (fetchImpl: typeof fetch) => new ApiClient({ endpoint: "/api/dewee", fetch: fetchImpl });

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("anonymous refresh hint", () => {
  it("does not refresh a short-lived anonymous session immediately", async () => {
    const b = backend(false, () => jsonRes(200, { visitorId: "visitor", token: "short", expiresAt: Date.now() + 10000, expiresIn: 10000 }));
    const api = page(b.fetch);
    await api.ensureSession();
    await api.ensureSession();
    expect(b.bodies).toHaveLength(1);
  });
  it("removes an obsolete signed-in session from local storage", async () => {
    const key = "dewee-webchat:session:/api/dewee";
    localStorage.setItem(key, JSON.stringify({ verified: true, token: "obsolete" }));
    const b = backend(true, () => jsonRes(200, { visitorId: "member", token: "current", verified: true, expiresAt: Date.now() + 3600000, expiresIn: 3600000 }));
    await page(b.fetch).ensureSession();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("waits for an in-flight signed-in renewal before sending history", async () => {
    let release!: (value: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    let started = false;
    let authorization = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url), "https://site.test").pathname;
      if (path.endsWith("/config")) return jsonRes(200, { identity: true });
      if (path.endsWith("/session")) { started = true; return response; }
      authorization = (init?.headers as Record<string, string>).authorization;
      return jsonRes(200, { messages: [] });
    });
    localStorage.setItem("dewee-webchat:session:/api/dewee", JSON.stringify({ visitorId: "anon", token: "anonymous-token", expiresAt: Date.now() + 86400000 }));
    const api = page(fetchImpl as typeof fetch);
    const renewal = api.renewSession();
    await vi.waitFor(() => expect(started).toBe(true));
    const history = api.history("shop", "conversation");
    await Promise.resolve();
    expect(authorization).toBe("");
    release(jsonRes(200, { visitorId: "member", token: "member-token", verified: true, expiresAt: Date.now() + 3600000, expiresIn: 3600000 }));
    await Promise.all([renewal, history]);
    expect(authorization).toBe("Bearer member-token");
  });
  it("does not let an older anonymous load overwrite renewal after sign-in", async () => {
    let releaseOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { releaseOld = resolve; });
    let count = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url), "https://site.test").pathname;
      if (path.endsWith("/config")) return jsonRes(200, { identity: true });
      if (path.endsWith("/session")) {
        count++;
        if (count === 1) return oldResponse;
        return jsonRes(200, { visitorId: "member", token: "member-token", verified: true, expiresAt: Date.now() + 3600000, expiresIn: 3600000 });
      }
      return jsonRes(200, { messages: [] });
    });
    const api = page(fetchImpl as typeof fetch);
    const old = api.ensureSession();
    await vi.waitFor(() => expect(count).toBe(1));
    const renewed = api.renewSession();
    await vi.waitFor(() => expect(count).toBe(2));
    expect((await renewed).token).toBe("member-token");
    releaseOld(jsonRes(200, { visitorId: "anonymous", token: "old-token", expiresAt: Date.now() + 3600000 }));
    expect((await old).token).toBe("member-token");
    expect((await api.ensureSession()).token).toBe("member-token");
    expect(localStorage.getItem("dewee-webchat:session:/api/dewee")).toBeNull();
  });

  it("propagates a failed renewal to an older load without silently retrying", async () => {
    let releaseOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { releaseOld = resolve; });
    let count = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (new URL(String(url), "https://site.test").pathname.endsWith("/config")) return jsonRes(200, { identity: true });
      count++;
      return count === 1 ? oldResponse : jsonRes(503, { error: { code: "SOURCE_UNAVAILABLE", message: "unavailable" } });
    });
    const api = page(fetchImpl as typeof fetch);
    const old = api.ensureSession();
    const oldResult = expect(old).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(count).toBe(1));
    await expect(api.renewSession()).rejects.toMatchObject({ status: 503 });
    releaseOld(jsonRes(200, { visitorId: "anonymous", token: "old", expiresAt: Date.now() + 3600000 }));
    await oldResult;
    expect(count).toBe(2);
  });
  it("comes back before the reported refresh point even though the token itself lives 30 days", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    const b = backend(false, (n) => jsonRes(200, { visitorId: "v_anon_001", token: `anon${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000 }));
    await page(b.fetch).ensureSession();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await page(b.fetch).ensureSession(); // a later page load: still fresh
    expect(b.bodies).toHaveLength(1);
    vi.setSystemTime(Date.now() + 26 * 60_000); // 4 min left, under the 6 min margin
    const s = await page(b.fetch).ensureSession();
    expect(b.bodies).toHaveLength(2);
    expect(b.bodies[1].token).toBe("anon1"); // same visitor refreshed, not a new one
    expect(s.token).toBe("anon2");
  });

  it("counts the hint from receipt, so a browser clock that runs ahead does not refresh every load", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    // The server's clock is 2 h behind the browser's: its absolute expiresAt is already "past".
    const b = backend(false, (n) => jsonRes(200, { visitorId: "v_anon_002", token: `anon${n}`, expiresAt: Date.now() - 3_600_000, expiresIn: 3_600_000 }));
    await page(b.fetch).ensureSession();
    await page(b.fetch).ensureSession();
    expect(b.bodies).toHaveLength(1);
  });
});

describe("signed-in reuse hint", () => {
  const verified = (n: number, extra: Record<string, unknown> = { reuseHint: `hint${n}` }) =>
    jsonRes(200, { visitorId: "v_member_01", token: `member${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000, verified: true, ...extra });

  it("keeps only the reuse hint in the tab and sends it on the next page load; the bearer token is never stored", async () => {
    const b = backend(true, (n) => verified(n));
    const api = page(b.fetch);
    await api.ensureSession();
    expect(b.bodies[0].reuseHint).toBeUndefined();
    expect(sessionStorage.getItem(HINT_KEY)).toBe("hint1");
    expect(api.reuseHint()).toBe("hint1");
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stored).not.toContain("member1");
    await page(b.fetch).ensureSession();
    expect(b.bodies[1].reuseHint).toBe("hint1");
    expect(JSON.stringify(b.bodies[1])).not.toContain("member1");
    expect(sessionStorage.getItem(HINT_KEY)).toBe("hint2");
  });

  it("writes nothing to sessionStorage when the backend sends no hint (legacy gateway, PHP)", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const b = backend(true, (n) => verified(n, {}));
      await page(b.fetch).ensureSession();
      await page(b.fetch).ensureSession();
      expect(setItem.mock.calls.filter(([k]) => String(k).startsWith("dewee-webchat:reuse:"))).toHaveLength(0);
      expect(sessionStorage.length).toBe(0);
      expect(b.bodies.every((x) => x.reuseHint === undefined)).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });

  it("drops the hint when the backend answers anonymously or refuses the session", async () => {
    const anon = backend(true, (n) => (n === 1 ? verified(n) : jsonRes(200, { visitorId: "v_anon_003", token: "anon", expiresAt: Date.now() + 3_600_000 })));
    await page(anon.fetch).ensureSession();
    await page(anon.fetch).ensureSession();
    expect(sessionStorage.getItem(HINT_KEY)).toBeNull();

    const refused = backend(true, (n) => (n === 1 ? verified(n) : jsonRes(401, { error: { code: "IDENTITY_REQUIRED", message: "sign in" } })));
    await page(refused.fetch).ensureSession();
    await expect(page(refused.fetch).ensureSession()).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("drops the hint of a session the backend refused on chat, so the renewal does not offer it again", async () => {
    const b = backend(true, (n) => jsonRes(200, { visitorId: "v_member_01", token: n === 1 ? "revoked" : `member${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000, verified: true, reuseHint: `hint${n}` }));
    const api = page(b.fetch);
    await api.chat({ agent: "shop", conversationId: "conv_hint_0001", message: "hi" }, () => {});
    expect(b.bodies).toHaveLength(2);
    expect(b.bodies[1].reuseHint).toBeUndefined();
    expect(sessionStorage.getItem(HINT_KEY)).toBe("hint2");
  });
});

describe("Turnstile on refresh", () => {
  const anon = (n: number) => jsonRes(200, { visitorId: "v_anon_010", token: `anon${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000 });
  const visit = async (b: ReturnType<typeof backend>, turnstile: () => Promise<string>) => {
    await new ApiClient({ endpoint: "/api/dewee", fetch: b.fetch, turnstile }).ensureSession();
  };

  it("challenges a new visitor, and refreshes a returning one without a challenge when the backend allows it", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    const turnstile = vi.fn(async () => "ts-token");
    const b = backend(false, anon, { turnstileSiteKey: "site-key", refreshWithoutTurnstile: true });
    await visit(b, turnstile);
    expect(turnstile).toHaveBeenCalledTimes(1);
    expect(b.bodies[0].turnstileToken).toBe("ts-token");
    vi.setSystemTime(Date.now() + 58 * 60_000);
    await visit(b, turnstile);
    expect(b.bodies).toHaveLength(2);
    expect(b.bodies[1]).toEqual({ token: "anon1" });
    expect(turnstile).toHaveBeenCalledTimes(1);
  });

  it("still challenges a refresh when the backend signs users in, since that refresh may sign one in", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    const turnstile = vi.fn(async () => "ts-token");
    const b = backend(true, anon, { turnstileSiteKey: "site-key", refreshWithoutTurnstile: true });
    await visit(b, turnstile);
    vi.setSystemTime(Date.now() + 58 * 60_000);
    await visit(b, turnstile);
    expect(b.bodies.map((x) => x.turnstileToken)).toEqual(["ts-token", "ts-token"]);
    expect(b.bodies[1].token).toBe("anon1");
    expect(turnstile).toHaveBeenCalledTimes(2);
  });

  it("keeps challenging every refresh when the backend does not say otherwise, and retries with one when asked", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    const turnstile = vi.fn(async () => "ts-token");
    const legacy = backend(false, anon, { turnstileSiteKey: "site-key" });
    await visit(legacy, turnstile);
    vi.setSystemTime(Date.now() + 58 * 60_000);
    await visit(legacy, turnstile);
    expect(legacy.bodies[1]).toEqual({ token: "anon1", turnstileToken: "ts-token" });

    localStorage.clear();
    turnstile.mockClear();
    const strict = backend(false, (n) => (n === 2 ? jsonRes(403, { error: { code: "turnstile_failed", message: "Verification failed" } }) : anon(n)), { turnstileSiteKey: "site-key", refreshWithoutTurnstile: true });
    await visit(strict, turnstile);
    vi.setSystemTime(Date.now() + 58 * 60_000);
    await visit(strict, turnstile);
    expect(strict.bodies.map((x) => x.turnstileToken)).toEqual(["ts-token", undefined, "ts-token"]);
  });
});

describe("<dewee-chat> reuseHint()", () => {
  it("hands the host page the tab's hint for its logout route", async () => {
    defineDeweeChat();
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("endpoint", "/api/dewee");
    expect(el.reuseHint()).toBeNull();
    const b = backend(true, (n) => jsonRes(200, { visitorId: "v_member_01", token: `member${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000, verified: true, reuseHint: `hint${n}` }));
    await page(b.fetch).ensureSession();
    expect(el.reuseHint()).toBe("hint1");
  });
});
