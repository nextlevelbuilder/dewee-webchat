import { isIdentityErrorCode, type IdentityErrorCode } from "../protocol";
import { parseJobAccessLaunch, type JobAccessLaunch } from "../job-access";

export class JobAccessRefusal extends Error {
  constructor(readonly code: IdentityErrorCode) { super("Job access was refused"); }
}

/** Direct transport uses only the verified session, never the operator credential. */
export async function mintJobAccess(gatewayUrl: string, identitySession: string, launchOrigin: string): Promise<JobAccessLaunch> {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== "/") {
    throw new Error("Job access is unavailable");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL("/v1/identity/job-access/launch", gateway), {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Dewee-Identity-Session": identitySession },
      body: JSON.stringify({ launch_origin: launchOrigin }),
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const code = (data as { error?: { code?: unknown } } | null)?.error?.code;
      if (isIdentityErrorCode(code)) throw new JobAccessRefusal(code);
      throw new Error("Job access is unavailable");
    }
    const launch = parseJobAccessLaunch(data);
    if (new URL(launch.bootstrap_url).origin !== gateway.origin || launch.launch_token === identitySession) {
      throw new Error("Job access is unavailable");
    }
    return launch;
  } finally { clearTimeout(timeout); }
}
