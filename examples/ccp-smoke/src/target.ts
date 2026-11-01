// Where the hosts' CCP traffic goes: the fake ingress (default, CI) or a real staging integration
// (DEWEE_SMOKE_TARGET=staging, credentials from the environment only). Values are never printed.
import { randomBytes } from "node:crypto";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp, type FakeCcp } from "../../../packages/dewee-webchat/test/helpers/fake-ccp-ingress";

export { APP_ID, ASSERTION_SECRET, INTEGRATION_SECRET };
export type { FakeCcp };

export const STAGING = process.env.DEWEE_SMOKE_TARGET === "staging";

/**
 * The site's public origin as browsers send it. Behind a reverse proxy (and under `next start`) the
 * host's `request.url` does not carry it, so it is listed in DEWEE_ALLOWED_ORIGINS like in production.
 */
export const SITE_ORIGIN = "https://shop.smoke.test";
/** Another site the hosts allow to embed the widget (CORS). */
export const PARTNER_ORIGIN = "https://partner.example";

export interface Target {
  /** Env every host gets: CCP settings plus this run's own visitor secret. */
  env: Record<string, string>;
  /** Present for signed-in checks: the identity application settings. */
  identity?: { appId: string; issuer: string; assertionSecret: string };
  /** Values that must never reach a browser. */
  secrets: string[];
  /** The Origin browsers send (staging: one the integration allows). */
  visitorOrigin: string;
  fake?: FakeCcp;
  close(): Promise<void>;
}

const INGRESS_RE = /^https:\/\/[^/?#]+\/api\/public\/webchat\/v1\/(wci_[a-z2-7]{26})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks the staging environment and names what is missing or malformed, never a value. Exported for
 * the runner script, which validates before starting anything.
 */
export function stagingProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is not set`);
    return v ?? "";
  };
  const url = need("DEWEE_CCP_CHAT_URL");
  const id = need("DEWEE_WEBCHAT_INTEGRATION_ID");
  const secret = need("DEWEE_WEBCHAT_INTEGRATION_SECRET");
  need("DEWEE_SMOKE_VISITOR_ORIGIN");
  const m = url ? INGRESS_RE.exec(url) : null;
  if (url && !m) problems.push("DEWEE_CCP_CHAT_URL must be https://…/api/public/webchat/v1/wci_… (from the CCP Website chat page)");
  if (m && id && m[1] !== id) problems.push("DEWEE_WEBCHAT_INTEGRATION_ID does not match the id in DEWEE_CCP_CHAT_URL");
  if (secret && !/^dwc_[A-Za-z0-9_-]{16,256}$/.test(secret)) problems.push("DEWEE_WEBCHAT_INTEGRATION_SECRET must be the private dwc_ integration secret");
  const origin = env.DEWEE_SMOKE_VISITOR_ORIGIN?.trim();
  if (origin && !/^https:\/\/[^/?#]+$/.test(origin)) problems.push("DEWEE_SMOKE_VISITOR_ORIGIN must be an https origin the integration allows");
  for (const name of ["DEWEE_GATEWAY_URL", "DEWEE_GATEWAY_TOKEN", "GOCLAW_GATEWAY_URL", "GOCLAW_GATEWAY_TOKEN"]) {
    if (env[name]) problems.push(`${name} is set: the CCP smoke must not see legacy Gateway credentials`);
  }
  if (env.DEWEE_IDENTITY_APP_ID) {
    if (!UUID_RE.test(env.DEWEE_IDENTITY_APP_ID)) problems.push("DEWEE_IDENTITY_APP_ID must be the application UUID");
    if (!env.DEWEE_IDENTITY_ISSUER) problems.push("DEWEE_IDENTITY_ISSUER is not set");
    if ((env.DEWEE_IDENTITY_ASSERTION_SECRET ?? "").length < 32) problems.push("DEWEE_IDENTITY_ASSERTION_SECRET is not set or shorter than 32 characters");
  }
  return problems;
}

/** This run's own HMAC key for visitor tokens, so tests can mint expired and forged tokens. */
export const VISITOR_SECRET = `smoke-visitor-${randomBytes(24).toString("base64url")}`;

export async function startTarget(): Promise<Target> {
  if (STAGING) {
    const problems = stagingProblems();
    if (problems.length) throw new Error(`Staging smoke environment is incomplete:\n- ${problems.join("\n- ")}`);
    const e = process.env;
    const identity = e.DEWEE_IDENTITY_APP_ID
      ? { appId: e.DEWEE_IDENTITY_APP_ID, issuer: e.DEWEE_IDENTITY_ISSUER!, assertionSecret: e.DEWEE_IDENTITY_ASSERTION_SECRET! }
      : undefined;
    return {
      env: {
        DEWEE_CCP_CHAT_URL: e.DEWEE_CCP_CHAT_URL!.trim(),
        DEWEE_WEBCHAT_INTEGRATION_ID: e.DEWEE_WEBCHAT_INTEGRATION_ID!.trim(),
        DEWEE_WEBCHAT_INTEGRATION_SECRET: e.DEWEE_WEBCHAT_INTEGRATION_SECRET!.trim(),
        DEWEE_WEBCHAT_SECRET: VISITOR_SECRET,
        DEWEE_ALLOWED_ORIGINS: `${e.DEWEE_SMOKE_VISITOR_ORIGIN!.trim()},${PARTNER_ORIGIN}`,
        SITE_ORIGIN: e.DEWEE_SMOKE_VISITOR_ORIGIN!.trim(),
      },
      identity,
      secrets: [e.DEWEE_WEBCHAT_INTEGRATION_SECRET!.trim(), VISITOR_SECRET, ...(identity ? [identity.assertionSecret] : [])],
      visitorOrigin: e.DEWEE_SMOKE_VISITOR_ORIGIN!.trim(),
      close: async () => {},
    };
  }
  const fake = await startFakeCcp();
  return {
    env: {
      DEWEE_CCP_CHAT_URL: fake.url,
      DEWEE_WEBCHAT_INTEGRATION_ID: INTEGRATION_ID,
      DEWEE_WEBCHAT_INTEGRATION_SECRET: INTEGRATION_SECRET,
      DEWEE_WEBCHAT_SECRET: VISITOR_SECRET,
      DEWEE_ALLOWED_ORIGINS: `${SITE_ORIGIN},${PARTNER_ORIGIN}`,
      SITE_ORIGIN,
    },
    identity: { appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET },
    secrets: [INTEGRATION_SECRET, VISITOR_SECRET, ASSERTION_SECRET],
    visitorOrigin: SITE_ORIGIN,
    fake,
    close: () => fake.close(),
  };
}
