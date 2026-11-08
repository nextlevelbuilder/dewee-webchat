// The CCP ingress client on its own: JSON calls have a deadline (and a failed config read is not
// shared afterwards), SSE framing survives chunk boundaries and a missing final blank line, and only
// known remediation values ever leave it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../src/protocol";
import { CCP_JSON_TIMEOUT_MS, CcpClient, CcpError, knownRemediation, parseCcpOptions, readSseJson } from "../src/server/ccp-client";
import { createCcpTransport, type CcpConfig } from "../src/server/ccp-transport";
import { createDeweeHandler } from "../src/server";
import { INTEGRATION_ID, INTEGRATION_SECRET } from "./helpers/fake-ccp-ingress";

const CHAT_URL = `https://ccp.example/api/public/webchat/v1/${INTEGRATION_ID}`;
const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A fetch that never answers on its own; it fails only when its signal aborts, as a real fetch does. */
const hangingFetch = (onCall?: () => void) =>
  vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    onCall?.();
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  });

const client = (fetchImpl: typeof fetch) => new CcpClient(parseCcpOptions({ chatUrl: CHAT_URL, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET, fetch: fetchImpl }));

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

async function frames(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const f of readSseJson(stream(chunks))) out.push(f);
  return out;
}

describe("CCP JSON calls have a deadline", () => {
  it("fails a call that gets no answer with ccp_timeout, and a caller's abort with the caller's reason", async () => {
    vi.useFakeTimers();
    const pending = client(hangingFetch() as unknown as typeof fetch).json("config");
    const settled = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(CCP_JSON_TIMEOUT_MS);
    const e = await settled;
    expect(e).toBeInstanceOf(CcpError);
    expect((e as CcpError).code).toBe("ccp_timeout");

    const caller = new AbortController();
    const aborted = client(hangingFetch() as unknown as typeof fetch).json("history", { signal: caller.signal }).catch((x) => x);
    caller.abort(new Error("browser left"));
    expect(((await aborted) as Error).message).toBe("browser left");
  });

  it("covers a body that stops arriving after the headers", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"agents":'));
          init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const settled = client(fetchImpl as unknown as typeof fetch).json("config").catch((e) => e);
    await vi.advanceTimersByTimeAsync(CCP_JSON_TIMEOUT_MS);
    expect(((await settled) as CcpError).code).toBe("ccp_timeout");
  });

  it("does not share a timed-out config read: the next request asks CCP again", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const config = { agents: [{ key: "shop" }], default_agent_key: "shop", mode: "anonymous" };
    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) return hangingFetch()(url, init);
      return Promise.resolve(new Response(JSON.stringify(config), { headers: { "content-type": "application/json" } }));
    });
    const h = createDeweeHandler({ ccp: { chatUrl: CHAT_URL, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET, fetch: fetchImpl as unknown as typeof fetch }, secret: VISITOR_SECRET, rateLimit: false });
    const cfg = () => h(new Request("https://shop.example/api/dewee/config"));
    const first = cfg();
    const second = cfg(); // waits on the same read
    await vi.advanceTimersByTimeAsync(CCP_JSON_TIMEOUT_MS);
    expect([(await first).status, (await second).status]).toEqual([502, 502]);
    expect(calls).toBe(1);
    const third = await cfg();
    expect(third.status).toBe(200);
    expect((await third.json()).defaultAgent).toBe("shop");
    expect(calls).toBe(2);
  });
});

describe("SSE framing", () => {
  it("joins a CRLF split across two chunks instead of reading an extra blank line", async () => {
    // Two data lines of one frame; the first line's \r\n is split between the chunks.
    expect(await frames(['data: {"a":\r', '\ndata: 1}\r\n\r\n'])).toEqual([{ a: 1 }]);
    expect(await frames(['data: {"a":1}\r\n\r', "\n", 'data: {"b":2}\r\n\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("delivers a last frame that lacks its closing blank line", async () => {
    expect(await frames(['data: {"type":"delta","text":"x"}\n\n', 'data: {"type":"done","content":"x"}'])).toEqual([
      { type: "delta", text: "x" },
      { type: "done", content: "x" },
    ]);
    expect(await frames(['data: {"type":"done"}\r'])).toEqual([{ type: "done" }]);
  });

  it("accepts bare CR line endings and skips comments and non-JSON frames", async () => {
    expect(await frames([": ping\r\r", 'data: {"b":2}\r\r', "data: not json\r\r"])).toEqual([{ b: 2 }]);
  });

  it("ends a turn whose terminal frame came without a blank line", async () => {
    const transport = createCcpTransport(client(hangingFetch() as unknown as typeof fetch));
    const cfg: CcpConfig = { agents: [{ id: "shop" }], defaultAgent: "shop", allowAgentSwitch: false, mode: "anonymous", identityEnabled: false, memberLinkProof: false, showThinking: false, showToolActivity: false, maxMessageChars: 100, pageContextVersions: [] };
    const res = new Response(stream(['data: {"type":"start","runId":"r1"}\r\n\r', '\ndata: {"type":"delta","text":"hi"}\r\n\r\ndata: {"type":"done","content":"hi"}']));
    const events: ChatStreamEvent[] = [];
    for await (const e of transport.chatEvents(res, cfg, "conv_sse_0001", "shop")) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "done"]);
  });
});

describe("remediation from CCP", () => {
  it("keeps only the contract's actions and audiences", () => {
    expect(knownRemediation({ action: "reauthenticate", audience: "end_user" })).toEqual({ action: "reauthenticate", audience: "end_user" });
    expect(knownRemediation({ action: "send_connect_link", audience: "integrator", extra: "dropped" })).toEqual({ action: "send_connect_link", audience: "integrator" });
    for (const bad of [{ action: "open https://evil.example", audience: "end_user" }, { action: "reauthenticate", audience: "everyone" }, { action: "x".repeat(5000), audience: "end_user" }, { action: 1, audience: "end_user" }, "reauthenticate", null]) {
      expect(knownRemediation(bad)).toBeUndefined();
    }
  });

  it("drops an unknown remediation from a stream error", async () => {
    const transport = createCcpTransport(client(hangingFetch() as unknown as typeof fetch));
    const cfg: CcpConfig = { agents: [{ id: "shop" }], defaultAgent: "shop", allowAgentSwitch: false, mode: "anonymous", identityEnabled: false, memberLinkProof: false, showThinking: false, showToolActivity: false, maxMessageChars: 100, pageContextVersions: [] };
    const run = async (remediation: unknown) => {
      const res = new Response(stream([`data: ${JSON.stringify({ type: "error", code: "LINK_REVOKED", remediation })}\n\n`]));
      const out: ChatStreamEvent[] = [];
      for await (const e of transport.chatEvents(res, cfg, "conv_sse_0002", "shop")) out.push(e);
      return out.at(-1);
    };
    expect(await run({ action: "<img src=x onerror=alert(1)>", audience: "end_user" })).toEqual({ type: "error", code: "LINK_REVOKED", message: "Your access was revoked." });
    expect(await run({ action: "reauthenticate", audience: "end_user" })).toEqual({ type: "error", code: "LINK_REVOKED", message: "Your access was revoked.", remediation: { action: "reauthenticate", audience: "end_user" } });
  });
});
