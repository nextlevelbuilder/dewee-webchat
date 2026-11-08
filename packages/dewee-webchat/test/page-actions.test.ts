import { describe, expect, it, vi } from "vitest";
import {
  DIRECTIVE_LIMITS,
  formatActionResults,
  isActionResultMessage,
  parseActionResults,
  parseDirectives,
  stripDirectives,
} from "../src/actions/directives";
import { validateJsonSchema } from "../src/actions/json-schema-subset";
import { ActionRegistry, runActionCall, type PageAction } from "../src/actions/action-runner";
import { buildPageBlock, hashManifest, normalizeManifest, stripPageBlock } from "../src/actions/page-block";

const fence = (body: string, lang = "dewee-action") => "```" + lang + "\n" + body + "\n```";

describe("parseDirectives", () => {
  it("extracts calls and hides blocks from the visible text", () => {
    const content = `Opening the runs page.\n\n${fence('{"id":"a1","name":"navigate","args":{"route":"/runs"}}')}\n${fence('{"name":"runs.list"}')}`;
    const { text, calls } = parseDirectives(content);
    expect(text).toBe("Opening the runs page.");
    expect(calls).toEqual([
      { ok: true, id: "a1", name: "navigate", args: { route: "/runs" } },
      { ok: true, id: "call-2", name: "runs.list", args: {} },
    ]);
  });

  it("leaves answers without directives untouched", () => {
    const content = "Plain answer\n```js\nconsole.log(1)\n```";
    expect(parseDirectives(content)).toEqual({ text: content, calls: [] });
  });

  it("turns malformed blocks into error calls", () => {
    const { calls } = parseDirectives(
      [fence("not json"), fence("[1,2]"), fence('{"id":"x"}'), fence('{"id":"y","name":"a","args":[1]}'), fence('{"id":"y","name":"b"}')].join("\n"),
    );
    expect(calls.map((c) => (c.ok ? "ok" : c.error))).toEqual([
      "Action block is not valid JSON",
      "Action block must be a JSON object",
      "Action name is required",
      "args must be a JSON object",
      'Duplicate action call id "y"',
    ]);
  });

  it("rejects unclosed and oversized blocks", () => {
    const big = JSON.stringify({ name: "a", args: { x: "y".repeat(DIRECTIVE_LIMITS.maxBlockBytes) } });
    const { calls } = parseDirectives(`${fence(big)}\n\`\`\`dewee-action\n{"name":"b"}`);
    expect(calls.map((c) => !c.ok && c.error)).toEqual([`Action block exceeds ${DIRECTIVE_LIMITS.maxBlockBytes} bytes`, "Unclosed dewee-action block"]);
  });

  it("caps the number of calls per reply", () => {
    const blocks = Array.from({ length: DIRECTIVE_LIMITS.maxCalls + 2 }, (_, i) => fence(`{"id":"c${i}","name":"a"}`)).join("\n");
    const { calls } = parseDirectives(blocks);
    expect(calls.filter((c) => c.ok)).toHaveLength(DIRECTIVE_LIMITS.maxCalls);
    expect(calls.filter((c) => !c.ok)).toHaveLength(2);
  });

  it("replaces unsafe ids with a positional fallback", () => {
    const { calls } = parseDirectives(fence('{"id":"<img src=x>","name":"a"}'));
    expect(calls[0]).toMatchObject({ ok: true, id: "call-1" });
  });

  it("stripDirectives hides a block that is still streaming", () => {
    expect(stripDirectives('Done.\n```dewee-action\n{"name":"na')).toBe("Done.");
    expect(stripDirectives("no blocks")).toBe("no blocks");
  });
});

describe("action results", () => {
  it("restores results when history collapses fence newlines", () => {
    const msg = '```dewee-action-result {"id":"a1","name":"navigate","status":"ok","result":{"route":"/runs"}} ```';
    expect(isActionResultMessage(msg)).toBe(true);
    expect(parseActionResults(msg)).toEqual([{ id: "a1", name: "navigate", status: "ok", result: { route: "/runs" } }]);
    expect(isActionResultMessage(`Please explain ${msg}`)).toBe(false);
  });

  it("keeps fences and escaped quotes inside compact result JSON", () => {
    const result = { id: "a1", name: "navigate", status: "ok", result: { text: '```sample``` "quoted"' } };
    const compact = `\`\`\`dewee-action-result ${JSON.stringify(result)} \`\`\``;
    expect(parseActionResults(compact)).toEqual([result]);
  });
  it("round-trips through the follow-up message", () => {
    const msg = formatActionResults([
      { id: "a1", name: "navigate", status: "ok", result: { route: "/runs" } },
      { id: "a2", name: "runs.delete", status: "denied", error: "The user declined this action." },
    ]);
    expect(isActionResultMessage(msg)).toBe(true);
    expect(isActionResultMessage("hello")).toBe(false);
    expect(parseActionResults(msg)).toEqual([
      { id: "a1", name: "navigate", status: "ok", result: { route: "/runs" } },
      { id: "a2", name: "runs.delete", status: "denied", error: "The user declined this action." },
    ]);
  });

  it("truncates oversized results to fit the message limit", () => {
    const msg = formatActionResults([{ id: "a1", name: "runs.list", status: "ok", result: { rows: "z".repeat(10000) } }], 1000);
    expect(msg.length).toBeLessThanOrEqual(1000);
    const [r] = parseActionResults(msg);
    expect(r.result).toMatchObject({ truncated: true });
  });
});

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    properties: { route: { type: "string", enum: ["/", "/runs"] }, limit: { type: "integer", minimum: 1, maximum: 50 }, tags: { type: "array", items: { type: "string", pattern: "^[a-z]+$" }, maxItems: 2 } },
    required: ["route"],
    additionalProperties: false,
  };
  it("accepts valid args and reports the first problem", () => {
    expect(validateJsonSchema({ route: "/runs", limit: 10, tags: ["a"] }, schema)).toBeNull();
    expect(validateJsonSchema({}, schema)).toBe("args.route: is required");
    expect(validateJsonSchema({ route: "javascript:alert(1)" }, schema)).toMatch(/must be one of/);
    expect(validateJsonSchema({ route: "/", limit: 1.5 }, schema)).toMatch(/expected integer/);
    expect(validateJsonSchema({ route: "/", limit: 99 }, schema)).toBe("args.limit: must be <= 50");
    expect(validateJsonSchema({ route: "/", tags: ["A"] }, schema)).toMatch(/args.tags\[0\]: does not match/);
    expect(validateJsonSchema({ route: "/", extra: 1 }, schema)).toBe("args.extra: is not allowed");
  });
});

describe("runActionCall", () => {
  const make = (sensitivity: PageAction["sensitivity"], handler = vi.fn(async () => ({ ok: 1 }))) => {
    const registry = new ActionRegistry();
    registry.register({ name: "do.it", description: "Does it", sensitivity, parameters: { type: "object", properties: { n: { type: "number" } } }, handler });
    return { registry, handler };
  };
  const base = { conversationId: "c1", agent: "support", signal: new AbortController().signal };
  const call = { ok: true as const, id: "x1", name: "do.it", args: { n: 1 } };

  it.each(["mutate", "destructive"] as const)("never runs a %s handler without approval", async (sensitivity) => {
    for (const answer of [false, undefined, "yes", 1, Promise.reject(new Error("boom"))]) {
      const { registry, handler } = make(sensitivity);
      const statuses: string[] = [];
      const r = await runActionCall(call, { ...base, registry, confirm: () => answer as any, onStatus: (s) => statuses.push(s) });
      expect(handler).not.toHaveBeenCalled();
      expect(r).toEqual({ id: "x1", name: "do.it", status: "denied", error: "The user declined this action." });
      expect(statuses).toEqual(["awaiting-confirmation", "denied"]);
    }
  });

  it("runs an approved mutate call and passes the action info to confirm", async () => {
    const { registry, handler } = make("mutate");
    const confirm = vi.fn(async (_action: unknown, _args: unknown) => true);
    const r = await runActionCall(call, { ...base, registry, confirm });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ name: "do.it", sensitivity: "mutate", callId: "x1" }), { n: 1 });
    expect(confirm.mock.calls[0][0]).not.toHaveProperty("handler");
    expect(handler).toHaveBeenCalledOnce();
    expect(r).toEqual({ id: "x1", name: "do.it", status: "ok", result: { ok: 1 } });
  });

  it("does not ask for read/navigate actions", async () => {
    for (const s of ["read", "navigate"] as const) {
      const { registry, handler } = make(s);
      const confirm = vi.fn(() => false);
      expect((await runActionCall(call, { ...base, registry, confirm })).status).toBe("ok");
      expect(confirm).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it("denies when the run is cancelled while awaiting approval", async () => {
    const { registry, handler } = make("destructive");
    const ctrl = new AbortController();
    const p = runActionCall(call, { ...base, signal: ctrl.signal, registry, confirm: () => new Promise<boolean>(() => {}) });
    ctrl.abort();
    expect((await p).status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports unknown actions, invalid args, handler errors and timeouts", async () => {
    const { registry } = make("read", vi.fn(async () => { throw new Error("nope"); }));
    const confirm = () => true;
    expect(await runActionCall({ ...call, name: "rm.rf" }, { ...base, registry, confirm })).toMatchObject({ status: "error", error: 'Unknown action "rm.rf". Available: do.it' });
    expect(await runActionCall({ ...call, args: { n: "1" } }, { ...base, registry, confirm })).toMatchObject({ status: "error", error: "Invalid arguments: args.n: expected number, got string" });
    expect(await runActionCall(call, { ...base, registry, confirm })).toMatchObject({ status: "error", error: "nope" });
    expect(await runActionCall({ ok: false, id: "b", name: "", error: "Action block is not valid JSON" }, { ...base, registry, confirm })).toMatchObject({ status: "error" });
    const slow = make("read", vi.fn(() => new Promise(() => {})));
    expect(await runActionCall(call, { ...base, registry: slow.registry, confirm, timeoutMs: 10 })).toMatchObject({ status: "error", error: "Timed out" });
  });
});

describe("ActionRegistry", () => {
  const ok: PageAction = { name: "a", description: "", sensitivity: "read", handler: () => null };
  it("validates definitions and caps the count", () => {
    const r = new ActionRegistry();
    expect(() => r.register({ ...ok, name: "Bad" })).toThrow(TypeError);
    expect(() => r.register({ ...ok, sensitivity: "admin" as any })).toThrow(TypeError);
    expect(() => r.register({ ...ok, handler: undefined as any })).toThrow(TypeError);
    r.register(Array.from({ length: 32 }, (_, i) => ({ ...ok, name: `a${i}` })));
    expect(() => r.register({ ...ok, name: "one.more" })).toThrow(/at most 32/);
    r.register({ ...ok, name: "a0", description: "replaced" });
    expect(r.size).toBe(32);
    expect(r.unregister("a0")).toBe(true);
    expect(r.manifest()[0]).toEqual({ name: "a1", description: "", sensitivity: "read", parameters: { type: "object", properties: {} } });
  });
});

describe("manifest + page block", () => {
  const nav = { name: "navigate", description: "Go", sensitivity: "navigate", parameters: { type: "object", properties: { route: { type: "string" } } } };
  it("hashes the normalized manifest independent of key order", async () => {
    const a = await hashManifest(normalizeManifest([nav]));
    const b = await hashManifest(normalizeManifest([{ parameters: nav.parameters, sensitivity: "navigate", description: "Go", name: "navigate" }]));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(await hashManifest(normalizeManifest([{ ...nav, description: "Go!" }]))).not.toBe(a);
  });

  it("includes the manifest once and only references it afterwards", async () => {
    const manifest = normalizeManifest([nav]);
    const hash = await hashManifest(manifest);
    const full = buildPageBlock({ manifest, hash, includeManifest: true, pageContext: '{"route":"/"}' });
    expect(full).toContain(`Actions: ${JSON.stringify(manifest)}`);
    expect(full).toContain('Page context: {"route":"/"}');
    const short = buildPageBlock({ manifest, hash, includeManifest: false });
    expect(short).not.toContain("Actions:");
    expect(short).toContain(`Page actions unchanged (manifest ${hash})`);
    expect(stripPageBlock(full + "What now?")).toBe("What now?");
    expect(buildPageBlock({})).toBe("");
  });
});
