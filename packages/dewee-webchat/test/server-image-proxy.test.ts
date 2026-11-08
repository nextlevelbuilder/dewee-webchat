import { describe, expect, it, vi } from "vitest";
import { BlockList } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchRasterImage, issueImageTicket, safeRasterDimensions, verifyImageTicket } from "../src/server/image-proxy";
import { publicImageAddresses, publicImageFetchNode } from "../src/server/public-image-fetch-node";

describe("bounded raster proxy", () => {
  it("accepts a PNG and strips upstream response headers", async () => {
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P1cAAAAASUVORK5CYII=", "base64"));
    const fetcher = vi.fn().mockResolvedValue(new Response(png, { headers: { "content-type": "image/png", "set-cookie": "secret=x" } }));
    const result = await fetchRasterImage("https://cdn.example/image", fetcher);
    expect(result?.headers.get("content-type")).toBe("image/png");
    expect(result?.headers.get("set-cookie")).toBeNull();
    expect([...new Uint8Array(await result!.arrayBuffer())]).toEqual([...png]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });

  it("refuses spoofed image types, SVG and oversized responses", async () => {
    for (const response of [
      new Response("<svg/>", { headers: { "content-type": "image/png" } }),
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
    ]) expect(await fetchRasterImage("https://cdn.example/image", vi.fn().mockResolvedValue(response))).toBeNull();
  });

  it("fails closed on a refused redirect or a failed request", async () => {
    expect(await fetchRasterImage("https://cdn.example/image", vi.fn().mockRejectedValue(new Error("redirect")))).toBeNull();
    expect(await fetchRasterImage("https://cdn.example/image", vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example" } })))).toBeNull();
  });

  it("refuses IP literals, local DNS answers and unsafe schemes before connecting", async () => {
    for (const url of ["https://127.0.0.1/image", "https://localhost/image", "http://example.com/image", "https://user:pass@example.com/image"]) {
      await expect(publicImageFetchNode(url)).rejects.toThrow();
    }
  });

  it("accepts public IPv4 and IPv6 but rejects mixed or reserved DNS answers", () => {
    const ip = (address: string, family: number) => ({ address, family });
    expect(publicImageAddresses([ip("8.8.8.8", 4), ip("2606:4700:4700::1111", 6)], BlockList)).toBe(true);
    for (const entry of [ip("127.0.0.1", 4), ip("100.64.1.2", 4), ip("192.0.2.1", 4), ip("::1", 6), ip("::ffff:127.0.0.1", 6), ip("2001:db8::1", 6)]) {
      expect(publicImageAddresses([ip("8.8.8.8", 4), entry], BlockList), entry.address).toBe(false);
    }
  });

  it("rejects excessive dimensions and animated containers", () => {
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P1cAAAAASUVORK5CYII=", "base64"));
    expect(safeRasterDimensions(png, "image/png")).toBe(true);
    const bomb = png.slice(); new DataView(bomb.buffer).setUint32(16, 100000);
    expect(safeRasterDimensions(bomb, "image/png")).toBe(false);
    expect(safeRasterDimensions(readFileSync(resolve(__dirname, "fixtures/images/animated.png")), "image/png")).toBe(false);
  });

  it("parses image container structure rather than searching compressed data for markers", () => {
    const fixture = (name: string) => readFileSync(resolve(__dirname, "fixtures/images", name));
    expect(fixture("static-noisy.gif").filter((byte) => byte === 0x2c).length).toBeGreaterThan(1);
    expect(safeRasterDimensions(fixture("static-noisy.gif"), "image/gif")).toBe(true);
    expect(safeRasterDimensions(fixture("animated.gif"), "image/gif")).toBe(false);
    expect(fixture("static-marker.png").includes(Buffer.from("acTL"))).toBe(true);
    expect(safeRasterDimensions(fixture("static-marker.png"), "image/png")).toBe(true);
    expect(safeRasterDimensions(fixture("animated.png"), "image/png")).toBe(false);
    expect(safeRasterDimensions(fixture("static.jpg"), "image/jpeg")).toBe(true);
    expect(safeRasterDimensions(fixture("static.webp"), "image/webp")).toBe(true);
    expect(safeRasterDimensions(fixture("static-alpha.webp"), "image/webp")).toBe(true);
    expect(safeRasterDimensions(fixture("animated.webp"), "image/webp")).toBe(false);
  });

  it("binds encrypted tickets to the integration and refuses tampering or expiry", async () => {
    const secret = "fixture-secret-at-least-32-bytes-long", source = "https://cdn.example/images/qr?secret=value";
    const ticket = await issueImageTicket(secret, "integration-a", "visitor_0123456789", source);
    expect(ticket).not.toContain("cdn.example");
    expect(await verifyImageTicket(secret, "integration-a", ticket)).toEqual({ visitor: "visitor_0123456789", source });
    expect(await verifyImageTicket(secret, "integration-b", ticket)).toBeNull();
    expect(await verifyImageTicket(secret, "integration-a", `${ticket[0] === "A" ? "B" : "A"}${ticket.slice(1)}`)).toBeNull();
    vi.useFakeTimers();
    try { vi.setSystemTime(Date.now() + 61_000); expect(await verifyImageTicket(secret, "integration-a", ticket)).toBeNull(); }
    finally { vi.useRealTimers(); }
  });
});
