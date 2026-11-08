import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => vi.fn());
vi.mock("../src/server/public-image-fetch-node", () => ({ publicImageFetchNode: network }));
import { createDeweeHandler, signVisitorToken } from "../src/server";
import { issueImageTicket, verifyImageTicket } from "../src/server/image-proxy";
import { ApiClient } from "../src/widget/api-client";

const secret = "fixture-secret-at-least-32-bytes-long";
const handler = () => createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false, imageSources: ["https://cdn.example/images/"] });
const token = () => signVisitorToken(secret, { v: "visitor_0123456789", exp: Date.now() + 60000 });
const ticketRequest = async (url: string, authenticated = true) => new Request("https://chat.example/api/dewee/image-ticket", { method: "POST", headers: authenticated ? { authorization: `Bearer ${await token()}` } : {}, body: JSON.stringify({ url }) });
const imageRequest = (ticket: string) => new Request(`https://chat.example/api/dewee/image?ticket=${encodeURIComponent(ticket)}`);
const png = () => new Response(new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P1cAAAAASUVORK5CYII=", "base64")), { headers: { "content-type": "image/png", "set-cookie": "upstream=secret" } });

describe("image proxy route", () => {
  beforeEach(() => { network.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());
  it("requires a session and proxies only a server-approved raster without forwarding credentials", async () => {
    network.mockResolvedValue(png());
    const h = handler();
    expect((await h(await ticketRequest("https://cdn.example/images/product.png", false))).status).toBe(401);
    expect((await h(imageRequest("invalid"))).status).toBe(401);
    const issued = await h(await ticketRequest("https://cdn.example/images/product.png?private=qr"));
    const { ticket } = await issued.json();
    expect(ticket).not.toContain("cdn.example");
    expect(await verifyImageTicket(secret, "https://gateway.example\n", ticket)).toMatchObject({ source: "https://cdn.example/images/product.png?private=qr" });
    const response = await h(imageRequest(ticket));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(network.mock.calls[0][0]).toBe("https://cdn.example/images/product.png?private=qr");
    expect(network.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });

  it("refuses unapproved origins and ambiguous paths before network access", async () => {
    const h = handler();
    for (const url of ["https://evil.example/image", "https://cdn.example@evil.example/image", "https://user@cdn.example/images/a", "https://cdn.example/images/a#fragment", "file:///etc/passwd", "https://cdn.example/images/line\nbreak", "https://cdn.example/images-evil/a", "https://cdn.example/images/%2fadmin", "https://cdn.example/images/%252fadmin"]) {
      expect((await h(await ticketRequest(url))).status, url).toBeGreaterThanOrEqual(400);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("revalidates the source after an allowlist change", async () => {
    const first = handler();
    const { ticket } = await (await first(await ticketRequest("https://cdn.example/images/product.png"))).json();
    const second = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false, imageSources: ["https://cdn.example/other/"] });
    expect((await second(imageRequest(ticket))).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
  });

  it("never proxies its own route path, even through an origin alias", async () => {
    const h = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false, imageSources: ["https://alias.example/api/dewee/"] });
    expect((await h(await ticketRequest("https://alias.example/api/dewee/image?ticket=other"))).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
    const root = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false, imageSources: ["https://alias.example/"] });
    const req = new Request("https://chat.example/image-ticket", { method: "POST", headers: { authorization: `Bearer ${await token()}` }, body: JSON.stringify({ url: "https://alias.example/image?ticket=other" }) });
    expect((await root(req)).status).toBe(403);
  });

  it("caps concurrent image fetches even when caller rate limiting is disabled", async () => {
    const releases: Array<(response: Response) => void> = [];
    network.mockImplementation(() => new Promise<Response>((resolve) => releases.push(resolve)));
    const h = handler();
    const { ticket } = await (await h(await ticketRequest("https://cdn.example/images/product.png"))).json();
    const active = Array.from({ length: 8 }, () => h(imageRequest(ticket)));
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    expect((await h(imageRequest(ticket))).status).toBe(429);
    for (const release of releases) release(png());
    expect((await Promise.all(active)).every((response) => response.status === 200)).toBe(true);
  });

  it("is disabled without server-side source configuration", async () => {
    const h = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false });
    expect((await h(imageRequest("invalid"))).status).toBe(404);
  });

  it("uses the Workers public fetch boundary", async () => {
    const workerFetch = vi.fn().mockResolvedValue(png());
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.stubGlobal("fetch", workerFetch);
    const h = handler();
    const { ticket } = await (await h(await ticketRequest("https://cdn.example/images/product.png"))).json();
    expect((await h(imageRequest(ticket))).status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect(network).not.toHaveBeenCalled();
    const sameZone = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false, imageSources: ["https://cdn.chat.example/images/"] });
    expect((await sameZone(await ticketRequest("https://cdn.chat.example/images/a.png"))).status).toBe(403);
  });

  it("serves only explicitly public same-origin Worker assets through the binding", async () => {
    const workerFetch = vi.fn();
    const binding = { fetch: vi.fn().mockImplementation(async () => png()) };
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.stubGlobal("fetch", workerFetch);
    const h = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false,
      imageSources: ["https://chat.example/public-chat-images/", "https://chat.example/private/", "https://cdn.chat.example/public-chat-images/"],
      cloudflarePublicImageAssets: { binding, prefixes: ["/public-chat-images/"] } });
    for (const url of ["https://chat.example/private/a.png", "https://cdn.chat.example/public-chat-images/a.png", "https://chat.example/public-chat-images/%2fprivate/a.png"]) {
      expect((await h(await ticketRequest(url))).status, url).toBe(403);
    }
    const legacyTicket = await issueImageTicket(secret, "https://gateway.example\n", "visitor_0123456789", "https://chat.example/public-chat-images/a.png");
    expect((await h(imageRequest(legacyTicket))).status).toBe(403);
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(workerFetch).not.toHaveBeenCalled();
    const { ticket } = await (await h(await ticketRequest("https://chat.example/public-chat-images/a.png?secret=discarded"))).json();
    const crossOrigin = new Request(`https://other.example/api/dewee/image?ticket=${encodeURIComponent(ticket)}`);
    expect((await h(crossOrigin)).status).toBe(401);
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(workerFetch).not.toHaveBeenCalled();
    expect((await h(imageRequest(ticket))).status).toBe(200);
    const request = binding.fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("https://assets.invalid/public-chat-images/a.png");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();

    binding.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
    expect((await h(imageRequest(ticket))).status).toBe(502);
    binding.fetch.mockResolvedValueOnce(new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } }));
    expect((await h(imageRequest(ticket))).status).toBe(502);
  });

  it("rejects broad or malformed public asset configuration", () => {
    for (const prefix of ["/", "relative/", "/public/../private/", "/public/%2f/", "/public"]) {
      expect(() => createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret,
        cloudflarePublicImageAssets: { binding: { fetch: async () => png() }, prefixes: [prefix] } })).toThrow();
    }
  });

  it("uses an explicitly public service for an allowed sibling origin without forwarding credentials", async () => {
    const workerFetch = vi.fn();
    const binding = { fetch: vi.fn().mockImplementation(async () => png()) };
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.stubGlobal("fetch", workerFetch);
    const options = { gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false as const,
      imageSources: ["https://cdn.chat.example/public/", "https://cdn.chat.example/private/"],
      cloudflarePublicImageServices: [{ id: "catalog-v1", binding, prefixes: ["https://cdn.chat.example/public/"] }] };
    const h = createDeweeHandler(options);
    expect((await h(await ticketRequest("https://cdn.chat.example/private/a.png"))).status).toBe(403);
    expect((await h(await ticketRequest("https://other.chat.example/public/a.png"))).status).toBe(403);
    expect((await h(await ticketRequest("https://cdn.chat.example/public/%2fprivate/a.png"))).status).toBe(403);
    const legacy = await issueImageTicket(secret, "https://gateway.example\n", "visitor_0123456789", "https://cdn.chat.example/public/a.png");
    expect((await h(imageRequest(legacy))).status).toBe(403);
    const { ticket } = await (await h(await ticketRequest("https://cdn.chat.example/public/a.png?secret=discarded"))).json();
    expect(ticket.startsWith("s.catalog-v1.")).toBe(true);
    expect((await h(new Request(`https://other.example/api/dewee/image?ticket=${ticket}`))).status).toBe(401);
    expect((await createDeweeHandler({ ...options, cloudflarePublicImageServices: [] })(imageRequest(ticket))).status).toBe(401);
    expect((await createDeweeHandler({ ...options, cloudflarePublicImageServices: [{ ...options.cloudflarePublicImageServices[0], id: "catalog-v2" }] })(imageRequest(ticket))).status).toBe(401);
    expect((await createDeweeHandler({ ...options, imageSources: ["https://cdn.chat.example/private/"] })(imageRequest(ticket))).status).toBe(403);
    expect((await h(imageRequest(ticket))).status).toBe(200);
    const request = binding.fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("https://public-images.invalid/public/a.png");
    expect(request.method).toBe("GET");
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(workerFetch).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    binding.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
    expect((await h(imageRequest(ticket))).status).toBe(502);
    binding.fetch.mockResolvedValueOnce(new Response("not an image", { headers: { "content-type": "image/png" } }));
    expect((await h(imageRequest(ticket))).status).toBe(502);
  });

  it("lets the browser client use the actual service-binding ticket issued by the handler", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const binding = { fetch: vi.fn().mockImplementation(async () => png()) };
    const h = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false,
      imageSources: ["https://cdn.chat.example/public/"], cloudflarePublicImageServices: [{ id: "catalog-v1", binding, prefixes: ["https://cdn.chat.example/public/"] }] });
    const client = new ApiClient({ endpoint: "https://chat.example/api/dewee", fetch: async (input, init) => {
      const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${await token()}`);
      return h(new Request(input, { ...init, headers }));
    } });
    const url = await client.imageUrl("https://cdn.chat.example/public/a.png");
    expect((await h(new Request(url))).status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledOnce();
  });

  it("refuses malformed service ticket tags before constructing an image URL", async () => {
    for (const ticket of ["s..cipher", "s.a.b.extra", "s.a../cipher", "s.a.cipher?other=x", `s.${"x".repeat(65)}.cipher`, `s.a.${"x".repeat(8193)}`]) {
      const client = new ApiClient({ endpoint: "https://chat.example/api/dewee", fetch: async () => new Response(JSON.stringify({ ticket }), { headers: { "content-type": "application/json" } }) });
      await expect(client.imageUrl("https://cdn.chat.example/public/a.png"), ticket.slice(0, 80)).rejects.toThrow("Invalid image ticket");
    }
  });

  it("rejects malformed or broad public service prefixes", () => {
    for (const prefix of ["https://cdn.example/", "https://cdn.example/public/../private/", "https://cdn.example/public/%2f/", "http://cdn.example/public/", "https://cdn.example/public/?secret=x"]) {
      expect(() => createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret,
        cloudflarePublicImageServices: [{ id: "public", binding: { fetch: async () => png() }, prefixes: [prefix] }] })).toThrow();
    }
    const binding = { fetch: async () => png() };
    expect(() => createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret,
      cloudflarePublicImageServices: [{ id: "a", binding, prefixes: ["https://cdn.example/public/"] }, { id: "b", binding, prefixes: ["https://cdn.example/public/products/"] }] })).toThrow();
    expect(() => createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret,
      cloudflarePublicImageServices: [{ id: "a", binding, prefixes: ["https://cdn.example/public/"] }, { id: "a", binding, prefixes: ["https://cdn.example/other/"] }] })).toThrow();
  });

  it("checks only the named service namespace for an invalid ticket", async () => {
    const binding = { fetch: async () => png() };
    const services = Array.from({ length: 16 }, (_, i) => ({ id: `service-${i}`, binding, prefixes: [`https://cdn.example/path-${i}/`] }));
    const h = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret,
      imageSources: ["https://cdn.example/path-0/"], cloudflarePublicImageServices: services });
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    try {
      const invalid = Buffer.alloc(32).toString("base64url");
      expect((await h(imageRequest(`s.service-0.${invalid}`))).status).toBe(401);
      expect(decrypt).toHaveBeenCalledTimes(1);
    } finally { decrypt.mockRestore(); }
  });

  it("uses an explicit asset binding even without a Workers user agent", async () => {
    const binding = { fetch: vi.fn().mockImplementation(async () => png()) };
    const h = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false,
      imageSources: ["https://chat.example/public-chat-images/"], cloudflarePublicImageAssets: { binding, prefixes: ["/public-chat-images/"] } });
    const { ticket } = await (await h(await ticketRequest("https://chat.example/public-chat-images/a.png"))).json();
    const changed = createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "server-only", secret, agents: ["support"], rateLimit: false,
      imageSources: ["https://chat.example/public-chat-images/"] });
    expect((await changed(imageRequest(ticket))).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
    expect((await h(imageRequest(ticket))).status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
  });
});
