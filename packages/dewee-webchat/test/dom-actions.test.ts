// @vitest-environment happy-dom
// Built-in DOM actions: what the snapshot exposes, ref/generation checks, and how click/fill/scroll act.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomActions, type DomActions } from "../src/actions/dom-actions";

const ctx = { callId: "c", conversationId: "v", agent: "a", signal: new AbortController().signal };
let dom: DomActions;
let root: string | Element | undefined;
const run = (name: string, args: Record<string, unknown> = {}) => dom.actions.find((a) => a.name === name)!.handler(args, ctx) as any;

beforeEach(() => {
  root = undefined;
  dom = createDomActions({ root: () => root, exclude: (el) => el.closest("dewee-chat") !== null });
});
afterEach(() => { document.body.innerHTML = ""; });

describe("page.snapshot", () => {
  it("lists visible interactive elements and skips sensitive, hidden, ignored and widget elements", () => {
    document.body.innerHTML = `
      <a href="/runs">Runs</a>
      <button aria-label="Save draft">💾</button>
      <label for="email">Email</label><input id="email" value="a@b.c">
      <input type="checkbox" checked aria-label="Remember me">
      <select name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
      <input type="password" name="pw" aria-label="Password">
      <input autocomplete="cc-number" aria-label="Card">
      <input name="otp_code" aria-label="Code">
      <input type="hidden" name="csrf" value="x">
      <button hidden>Hidden attr</button>
      <div style="display:none"><button>Inside display none</button></div>
      <div data-dewee-ignore><button>Ignored</button></div>
      <dewee-chat><button>Widget</button></dewee-chat>
      <button disabled>Disabled</button>`;
    const snap = run("page.snapshot");
    expect(snap.generation).toBe(1);
    expect(snap.elements).toEqual([
      'e1 link "Runs" href="/runs"',
      'e2 button "Save draft"',
      'e3 textbox "Email" value="a@b.c"',
      'e4 checkbox "Remember me" checked',
      'e5 combobox "plan" value="free"',
      'e6 button "Disabled" disabled',
    ]);
    expect(snap.total).toBe(6);
    expect(JSON.stringify(snap)).not.toMatch(/Password|Card|Code|csrf|Hidden attr|display none|Ignored|Widget/);
  });

  it("filters by query and pages with offset/limit, keeping refs stable within the generation", () => {
    document.body.innerHTML = Array.from({ length: 5 }, (_, i) => `<button>Item ${i + 1}</button>`).join("") + "<a href='/x'>Other</a>";
    expect(run("page.snapshot", { query: "item", offset: 2, limit: 2 }).elements).toEqual(['e3 button "Item 3"', 'e4 button "Item 4"']);
    const snap = run("page.snapshot", { query: "other" });
    expect(snap).toMatchObject({ generation: 2, total: 1, elements: ['e1 link "Other" href="/x"'] });
  });

  it("stays inside domActionsRoot", () => {
    document.body.innerHTML = `<button>Outside</button><section id="app"><button>Inside</button></section>`;
    root = "#app";
    expect(run("page.snapshot").elements).toEqual(['e1 button "Inside"']);
    root = "#missing";
    expect(() => run("page.snapshot")).toThrow(/matches no element/);
  });
});

describe("refs", () => {
  it("refuses refs from an older generation, unknown refs and elements that went away", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    run("page.snapshot");
    run("page.snapshot");
    expect(() => run("page.click", { ref: "e1", generation: 1 })).toThrow(/Stale ref/);
    expect(() => run("page.click", { ref: "e9", generation: 2 })).toThrow(/Unknown ref/);
    document.getElementById("b")!.remove();
    expect(() => run("page.click", { ref: "e1", generation: 2 })).toThrow(/no longer available/);
    expect(() => run("page.click", { ref: "e1", generation: 1 })).toThrow(/Stale ref/);
  });

  it("refuses an element that became sensitive or ignored after the snapshot", () => {
    document.body.innerHTML = `<input id="f" aria-label="Name">`;
    run("page.snapshot");
    document.getElementById("f")!.setAttribute("type", "password");
    expect(() => run("page.fill", { ref: "e1", generation: 1, text: "x" })).toThrow(/no longer available/);
  });

  it("names the target for the approval dialog", () => {
    document.body.innerHTML = `<button>Delete run</button>`;
    run("page.snapshot");
    expect(dom.target({ ref: "e1", generation: 1 })).toBe('button "Delete run"');
    expect(dom.target({ ref: "e1", generation: 7 })).toBeUndefined();
  });
});

describe("page.click", () => {
  it("clicks the element and refuses disabled ones", () => {
    document.body.innerHTML = `<button id="ok">Save</button><button disabled>Off</button>`;
    const onClick = vi.fn();
    document.getElementById("ok")!.addEventListener("click", onClick);
    const snap = run("page.snapshot");
    expect(run("page.click", { ref: "e1", generation: snap.generation })).toEqual({ ref: "e1", clicked: 'button "Save"' });
    expect(onClick).toHaveBeenCalledOnce();
    expect(() => run("page.click", { ref: "e2", generation: snap.generation })).toThrow(/disabled/);
  });
});

describe("page.fill", () => {
  it("sets the value through the prototype setter and fires input and change", () => {
    document.body.innerHTML = `<input id="q" aria-label="Search">`;
    const input = document.getElementById("q") as HTMLInputElement;
    // Like React's value tracker: an instance-level `value` property that records direct assignments.
    let tracked = "";
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(input, "value", { configurable: true, get() { return proto.get!.call(this); }, set(v) { tracked = v; proto.set!.call(this, v); } });
    const events: string[] = [];
    input.addEventListener("input", () => events.push(`input:${input.value}`));
    input.addEventListener("change", () => events.push("change"));
    run("page.snapshot");
    expect(run("page.fill", { ref: "e1", generation: 1, text: "dewee" })).toEqual({ ref: "e1", value: "dewee" });
    expect(events).toEqual(["input:dewee", "change"]);
    expect(tracked).toBe(""); // the tracker still holds the old value, so the framework sees a change
  });

  it("fills textareas, selects by value or label, and contenteditable", () => {
    document.body.innerHTML = `
      <textarea aria-label="Note"></textarea>
      <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro plan</option></select>
      <div contenteditable="true" aria-label="Body">old</div>`;
    run("page.snapshot");
    run("page.fill", { ref: "e1", generation: 1, text: "hi" });
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hi");
    expect(run("page.fill", { ref: "e2", generation: 1, text: "pro plan" }).value).toBe("pro");
    expect(() => run("page.fill", { ref: "e2", generation: 1, text: "gold" })).toThrow(/No option/);
    run("page.fill", { ref: "e3", generation: 1, text: "new" });
    expect(document.querySelector("[contenteditable]")!.textContent).toBe("new");
  });

  it("refuses checkboxes, buttons and read-only fields", () => {
    document.body.innerHTML = `<input type="checkbox" aria-label="A"><button>B</button><input readonly aria-label="C">`;
    run("page.snapshot");
    expect(() => run("page.fill", { ref: "e1", generation: 1, text: "x" })).toThrow(/use page.click/);
    expect(() => run("page.fill", { ref: "e2", generation: 1, text: "x" })).toThrow(/cannot be filled/);
    expect(() => run("page.fill", { ref: "e3", generation: 1, text: "x" })).toThrow(/not editable/);
  });
});

describe("page.scroll", () => {
  it("scrolls the window by direction and an element into view by ref", () => {
    document.body.innerHTML = `<button>Far</button>`;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    run("page.scroll", { direction: "top" });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    run("page.scroll", { direction: "down" });
    expect(scrollTo.mock.lastCall![0]).toEqual({ top: window.scrollY + 0.8 * window.innerHeight });
    const snap = run("page.snapshot");
    const btn = document.querySelector("button")!;
    btn.scrollIntoView = vi.fn();
    expect(run("page.scroll", { ref: "e1", generation: snap.generation })).toMatchObject({ ref: "e1" });
    expect(btn.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    expect(() => run("page.scroll", { ref: "e1" })).toThrow(/generation is required/);
    expect(() => run("page.scroll", {})).toThrow(/direction or a ref/);
    scrollTo.mockRestore();
  });
});
