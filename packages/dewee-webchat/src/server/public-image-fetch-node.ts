// Node's ordinary fetch resolves DNS after application-level validation. Pin the checked address
// to the connection instead, keeping the original hostname for TLS verification and SNI.
export async function publicImageFetchNode(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (typeof input !== "string") throw new Error("Invalid image URL");
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Invalid image URL");
  // Computed imports keep the generic server entry loadable in runtimes without Node builtins.
  const prefix = "node:";
  const dns: typeof import("node:dns/promises") = await import(prefix + "dns/promises");
  const net: typeof import("node:net") = await import(prefix + "net");
  const https: typeof import("node:https") = await import(prefix + "https");
  if (net.isIP(url.hostname)) throw new Error("IP literals are not allowed");
  const lookup = dns.lookup(url.hostname, { all: true, verbatim: true });
  const signal = init?.signal;
  const addresses = signal ? await new Promise<Awaited<typeof lookup>>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Image request timed out")); return; }
    const abort = () => reject(new Error("Image request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    lookup.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  }) : await lookup;
  if (!addresses.length) throw new Error("No image address");
  if (!publicImageAddresses(addresses, net.BlockList)) throw new Error("Non-public image address");
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(url, {
      method: "GET", headers: { accept: "image/png,image/jpeg,image/gif,image/webp" }, signal: init?.signal ?? undefined,
      family: chosen.family,
      lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
    }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || response.statusCode === 204 || response.statusCode === 205) {
        response.destroy();
        reject(new Error("Image upstream refused"));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (typeof value === "string") headers.set(name, value);
      let received = 0;
      let settled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.pause();
          response.on("data", (chunk: Buffer) => {
            response.pause();
            received += chunk.length;
            if (received > 2 * 1024 * 1024) {
              settled = true;
              response.destroy();
              controller.error(new Error("Image too large"));
            } else controller.enqueue(new Uint8Array(chunk));
          });
          response.on("end", () => { if (!settled) { settled = true; controller.close(); } });
          response.on("error", (error) => { if (!settled) { settled = true; controller.error(error); } });
        },
        pull() { response.resume(); },
        cancel() { settled = true; response.destroy(); },
      });
      resolve(new Response(body, { status: response.statusCode ?? 502, headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Reject a DNS answer if any address is not globally routable. */
export function publicImageAddresses(addresses: Array<{ address: string; family: number }>, BlockList: typeof import("node:net").BlockList): boolean {
  const denied4 = new BlockList();
  const denied6 = new BlockList();
  for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) denied4.addSubnet(ip, bits, "ipv4");
  for (const [ip, bits] of [["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) denied6.addSubnet(ip, bits, "ipv6");
  const publicV6 = new BlockList();
  publicV6.addSubnet("2000::", 3, "ipv6");
  return addresses.length > 0 && addresses.every(({ address, family }) => family === 6 ? !denied6.check(address, "ipv6") && publicV6.check(address, "ipv6") : family === 4 && !denied4.check(address, "ipv4"));
}
