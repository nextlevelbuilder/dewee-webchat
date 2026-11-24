// Human takeover over transport "ccp": the opt-in `humanHandoff` host option, the `human-handoff`
// feature header, `POST /request-human`, the `202 held` chat answer, `control` and the author of each
// turn in `/history`, and that a host without the option behaves exactly as before.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuresHeader } from "../src/server/ccp-client";
import { createDeweeHandler, optionsFromEnv, type DeweeHandlerOptions } from "../src/server";
import { INTEGRATION_ID, INTEGRATION_SECRET, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";

const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const BASE = "https://shop.example/api/dewee";
let ccp: FakeCcp;

beforeAll(async () => {
  ccp = await startFakeCcp();
});
afterAll(() => ccp.close());
beforeEach(() => {
  ccp.reset();
  ccp.state.config = { ...ccp.state.config, human_handoff: true };
});

const browserOutput: string[] = [];

function makeHandler(extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET, rateLimit: false, ...extra });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    browserOutput.push(text, JSON.stringify(Object.fromEntries(res.headers)));
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };
}
type H = ReturnType<typeof makeHandler>;

const session = async (h: H) => (await h(new Request(`${BASE}/session`, { method: "POST", body: "{}" }))).json();
const chat = (h: H, token: string, body: Record<string, unknown> = {}) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ message: "hi", conversationId: "conv_hand_0001", agent: "shop", ...body }) }));
const history = (h: H, token: string, conversationId = "conv_hand_0001") =>
  h(new Request(`${BASE}/history?agent=shop&conversationId=${conversationId}`, { headers: { authorization: `Bearer ${token}` } }));
const requestHuman = (h: H, token: string, body: Record<string, unknown> = { conversationId: "conv_hand_0001", agent: "shop" }) =>
  h(new Request(`${BASE}/request-human`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

describe("human takeover: host without the option", () => {
  it("never offers it, never advertises it and never answers the route, even when the integration allows it", async () => {
    const h = makeHandler();
    expect((await h(new Request(`${BASE}/config`))).json().humanHandoff).toBeUndefined();
    const s = await session(h);
    expect((await chat(h, s.token)).status).toBe(200);
    const hist = (await history(h, s.token)).json();
    expect(hist).toEqual({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: expect.stringContaining("hello wcv:") }] });
    for (const r of [...ccp.routes("chat"), ...ccp.routes("history")]) expect(r.headers["x-dewee-webchat-features"]).toBeUndefined();
    const refused = await requestHuman(h, s.token);
    expect([refused.status, refused.json().error.code]).toEqual([404, "not_found"]);
    expect(ccp.routes("request-human")).toHaveLength(0);
  });

  it("is refused at startup on the legacy gateway, and read from the environment only as true", () => {
    expect(() => createDeweeHandler({ gatewayUrl: "https://gw.example.com", token: "gw", secret: VISITOR_SECRET, humanHandoff: true })).toThrow(/humanHandoff requires the ccp transport/);
    expect(() => createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET, humanHandoff: "yes" as unknown as boolean })).toThrow(/humanHandoff must be/);
    expect(optionsFromEnv({ DEWEE_WEBCHAT_HUMAN_HANDOFF: "true" }).humanHandoff).toBe(true);
    for (const v of [undefined, "", "1", "false", "yes"]) expect(optionsFromEnv({ DEWEE_WEBCHAT_HUMAN_HANDOFF: v }).humanHandoff, String(v)).toBeUndefined();
  });

  it("joins the feature tokens CCP knows, and keeps the credential-only value unchanged", () => {
    expect(featuresHeader({})).toBeUndefined();
    expect(featuresHeader({ credentialRequests: true })).toBe("credential-requests");
    expect(featuresHeader({ humanHandoff: true })).toBe("human-handoff");
    expect(featuresHeader({ humanHandoff: true, credentialRequests: true })).toBe("human-handoff, credential-requests");
  });
});

describe("human takeover: opted-in host", () => {
  it("shows the offer only when the integration allows it too", async () => {
    const h = makeHandler({ humanHandoff: true });
    expect((await h(new Request(`${BASE}/config`))).json().humanHandoff).toBe(true);
    ccp.state.config = { ...ccp.state.config, human_handoff: false };
    const off = makeHandler({ humanHandoff: true }); // a new handler: the config is cached per handler
    expect((await off(new Request(`${BASE}/config`))).json().humanHandoff).toBeUndefined();
  });

  it("asks for a person, holds the next message without a run, and reloads the takeover from history", async () => {
    const onChat = vi.fn();
    const h = makeHandler({ humanHandoff: true, onChat });
    const s = await session(h);
    expect((await chat(h, s.token)).status).toBe(200);
    expect(ccp.routes("chat")[0].headers["x-dewee-webchat-features"]).toBe("human-handoff");

    const asked = await requestHuman(h, s.token, { conversationId: "conv_hand_0001", agent: "shop", summary: "  Refund for order 1042  " });
    expect([asked.status, asked.json()]).toEqual([200, { control: "waiting_human", staffOnDuty: true }]);
    expect(asked.text).not.toContain("case_0193");
    const sent = ccp.routes("request-human")[0];
    expect(sent.body).toEqual({ conversation_id: "conv_hand_0001", summary: "Refund for order 1042", agent: "shop" });
    expect(sent.headers["x-dewee-webchat-features"]).toBe("human-handoff");

    onChat.mockClear();
    const held = await chat(h, s.token, { message: "are you there?" });
    expect([held.status, held.headers.get("content-type"), held.json()]).toEqual([202, "application/json; charset=utf-8", { held: true, control: "waiting_human" }]);
    expect(onChat).not.toHaveBeenCalled();

    // Staff accept and reply; the staff member's identity in the upstream payload never reaches the browser.
    const conv = ccp.state.conversations.get(`wcv:${INTEGRATION_ID}:${s.visitorId}|conv_hand_0001`)!;
    conv.push({ role: "assistant", content: "Staff joined the conversation.", author_kind: "system" });
    conv.push({ role: "assistant", content: "Hi, I can help with the refund.", author_kind: "human", author_name: "Lan Nguyen", author_email: "lan@shop.example", author_id: "usr_0193", staff: { name: "Lan" } });
    ccp.state.control.set(`wcv:${INTEGRATION_ID}:${s.visitorId}|conv_hand_0001`, "human_active");
    const hist = await history(h, s.token);
    expect(hist.json()).toEqual({
      control: "human_active",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: expect.stringContaining("hello wcv:") },
        { role: "assistant", content: "A support staff member will join shortly.", authorKind: "system" },
        { role: "user", content: "are you there?" },
        { role: "assistant", content: "Staff joined the conversation.", authorKind: "system" },
        { role: "assistant", content: "Hi, I can help with the refund.", authorKind: "human" },
      ],
    });
    expect(hist.text).not.toMatch(/Lan Nguyen|lan@shop|usr_0193/);
    expect(ccp.routes("history").at(-1)?.headers["x-dewee-webchat-features"]).toBe("human-handoff");

    // Asking again while the case holds the conversation answers its current control.
    expect((await requestHuman(h, s.token)).json()).toEqual({ control: "human_active", staffOnDuty: true });

    // Staff hand the conversation back: the agent answers again and history says so.
    ccp.state.control.set(`wcv:${INTEGRATION_ID}:${s.visitorId}|conv_hand_0001`, "agent");
    expect((await history(h, s.token)).json().control).toBe("agent");
    expect((await chat(h, s.token, { message: "thanks" })).status).toBe(200);
  });

  it("with nobody on duty, keeps the conversation with the agent", async () => {
    ccp.state.staffOnDuty = false;
    const h = makeHandler({ humanHandoff: true });
    const s = await session(h);
    await chat(h, s.token);
    expect((await requestHuman(h, s.token)).json()).toEqual({ control: "agent", staffOnDuty: false });
    const next = await chat(h, s.token, { message: "ok" });
    expect([next.status, next.headers.get("content-type")]).toEqual([200, "text/event-stream; charset=utf-8"]);
    const hist = (await history(h, s.token)).json();
    expect(hist.control).toBe("agent");
    expect(hist.messages).toContainEqual({ role: "assistant", content: "Nobody is on duty right now. Please leave your contact details.", authorKind: "system" });
  });

  it("passes a stopped run on as cancelled so the widget can redraw from history", async () => {
    ccp.state.stopMidRun = true;
    const h = makeHandler({ humanHandoff: true });
    const s = await session(h);
    const r = await chat(h, s.token);
    const events = r.text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
    expect(events.at(-1)).toEqual({ type: "error", code: "cancelled", message: "Cancelled" });
    expect(r.text).not.toContain("case 0193");
  });

  it("refuses another visitor's conversation without telling it apart from a missing one", async () => {
    const h = makeHandler({ humanHandoff: true });
    const owner = await session(h);
    await chat(h, owner.token);
    const other = await session(h);
    const r = await requestHuman(h, other.token);
    expect([r.status, r.json()]).toEqual([404, { error: { message: "Not found", code: "not_found" } }]);
    expect(ccp.state.control.size).toBe(0);
    // The owner's conversation is untouched and still answered by the agent.
    expect((await chat(h, owner.token, { message: "still me" })).status).toBe(200);
  });

  it("validates the request before calling CCP", async () => {
    const h = makeHandler({ humanHandoff: true });
    const s = await session(h);
    for (const body of [{ conversationId: "short" }, { conversationId: "conv_hand_0001", extra: 1 }, { conversationId: "conv_hand_0001", summary: "x".repeat(1001) }, { conversationId: "conv_hand_0001", summary: "code MEM-ABCDEFGHIJKLMNOP" }, { conversationId: "conv_hand_0001", agent: "../x" }]) {
      expect((await requestHuman(h, s.token, body)).status, JSON.stringify(body)).toBe(400);
    }
    const anonymous = await h(new Request(`${BASE}/request-human`, { method: "POST", body: JSON.stringify({ conversationId: "conv_hand_0001" }) }));
    expect(anonymous.status).toBe(401);
    expect(ccp.routes("request-human")).toHaveLength(0);
  });

  it("maps CCP refusals: unavailable hides the button, anything else stays retryable, never CCP's text", async () => {
    const h = makeHandler({ humanHandoff: true });
    const s = await session(h);
    await chat(h, s.token);
    const remediation = { action: "contact_admin", audience: "end_user" };
    const cases: Array<[number, string, number, string, unknown?]> = [
      [403, "PERMISSION_DENIED", 403, "human_handoff_unavailable"],
      // An identity refusal (it names a remediation) stays one: it is not "unavailable".
      [403, "PERMISSION_DENIED", 403, "PERMISSION_DENIED", remediation],
      [403, "human_handoff_unavailable", 403, "human_handoff_unavailable"],
      [429, "rate_limited", 429, "rate_limited"],
      // Admission refusals keep their typed code so the widget shows its localized refusal.
      [429, "RATE_LIMITED", 429, "RATE_LIMITED"],
      [403, "POLICY_DENIED", 403, "POLICY_DENIED"],
      [500, "upstream_failed", 502, "gateway_error"],
      [502, "upstream_failed", 502, "gateway_error"],
    ];
    for (const [status, code, want, wantCode, withRemediation] of cases) {
      ccp.state.failNext.set("request-human", { status, code, ...(withRemediation ? { remediation: withRemediation } : {}) });
      const r = await quiet(() => requestHuman(h, s.token));
      expect([code, r.status, r.json().error.code]).toEqual([code, want, wantCode]);
      expect(r.text).not.toMatch(/postgres|0193/);
    }
    // The chat keeps working after a failed request.
    expect((await chat(h, s.token, { message: "still here" })).status).toBe(200);
  });

  it("applies this backend's own per-visitor limit before CCP's", async () => {
    const h = makeHandler({ humanHandoff: true, rateLimit: undefined });
    const s = await session(h);
    await chat(h, s.token);
    ccp.state.control.clear();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestHuman(h, s.token)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(ccp.routes("request-human")).toHaveLength(5);
  });

  it("never sends the integration secret, edge session, case id or staff identity to a browser", () => {
    const all = browserOutput.join("\n");
    for (const needle of [INTEGRATION_SECRET, VISITOR_SECRET, "dws1.", "case_0193", "lan@shop", "usr_0193"]) expect(all, needle).not.toContain(needle);
  });
});
