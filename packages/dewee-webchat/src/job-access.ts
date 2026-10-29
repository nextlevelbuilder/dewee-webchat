/** The only launch data allowed to reach the browser. Never an identity session. */
export interface JobAccessLaunch {
  bootstrap_url: string;
  launch_token: string;
  expires_at: string;
}

export function parseJobAccessLaunch(raw: unknown): JobAccessLaunch {
  const fail = (): never => { throw new Error("Job access is unavailable"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const data = raw as Record<string, unknown>;
  if (typeof data.bootstrap_url !== "string" || typeof data.launch_token !== "string" ||
      !/^[A-Za-z0-9_.-]{16,16384}$/.test(data.launch_token) || typeof data.expires_at !== "string") return fail();
  let url: URL;
  try { url = new URL(data.bootstrap_url); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/identity/job-access/launch" || url.href !== data.bootstrap_url) return fail();
  const deadline = Date.parse(data.expires_at);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 60_000) return fail();
  return { bootstrap_url: url.href, launch_token: data.launch_token, expires_at: data.expires_at };
}
