/** A value-free, server-authorized credential request. Never accept form values here. */
export interface CredentialRequestView {
  id: string;
  schema_version: "webchat-credential-request.v1";
  status: "pending" | "applying" | "resolved" | "cancelled" | "expired" | "failed";
  title: string;
  purpose: string;
  target: { type: string; mode: string };
  fields: Array<{ key: string; label: string; kind: string; required: boolean }>;
  expires_at: string;
  agent_key: string;
  completion: "hosted";
  resumable: boolean;
}

export interface CredentialHandoff { credential_request_id: string; url: string; expires_at: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(["pending", "applying", "resolved", "cancelled", "expired", "failed"]);
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));

/** Rebuild known fields, reject newer or malformed cards and never forward arbitrary properties. */
export function parseCredentialRequest(raw: unknown, expectedAgent: string): CredentialRequestView | null {
  const v = record(raw); const target = record(v?.target);
  if (!v || !target || !text(v.id, 36) || !uuid.test(v.id) || v.schema_version !== "webchat-credential-request.v1" ||
      typeof v.status !== "string" || !statuses.has(v.status) || !text(v.title, 300) || !text(v.purpose, 4000) ||
      !text(target.type, 100) || !text(target.mode, 100) || !Array.isArray(v.fields) || v.fields.length > 32 ||
      !date(v.expires_at) || v.agent_key !== expectedAgent || v.completion !== "hosted" || typeof v.resumable !== "boolean") return null;
  const fields: CredentialRequestView["fields"] = [];
  for (const item of v.fields) {
    const f = record(item);
    if (!f || !text(f.key, 100) || !/^[A-Za-z0-9_.-]+$/.test(f.key) || !text(f.label, 300) || !text(f.kind, 100) || typeof f.required !== "boolean") return null;
    fields.push({ key: f.key, label: f.label, kind: f.kind, required: f.required });
  }
  return { id: v.id, schema_version: "webchat-credential-request.v1", status: v.status as CredentialRequestView["status"], title: v.title, purpose: v.purpose,
    target: { type: target.type, mode: target.mode }, fields, expires_at: v.expires_at, agent_key: expectedAgent, completion: "hosted", resumable: v.resumable };
}

/** The one-time link is accepted only at a host configured by the integrator. */
export function parseCredentialHandoff(raw: unknown, expectedId: string, trustedOrigin: string): CredentialHandoff | null {
  const v = record(raw);
  if (!v || v.credential_request_id !== expectedId || !text(v.url, 4096) || !date(v.expires_at) || Date.parse(v.expires_at) <= Date.now()) return null;
  try {
    const url = new URL(v.url);
    if (url.protocol !== "https:" || url.origin !== trustedOrigin || url.username || url.password || url.hash || url.pathname !== "/credential-requests/open" || !/^\?token=[A-Za-z0-9_-]{43}$/.test(url.search)) return null;
    return { credential_request_id: expectedId, url: url.href, expires_at: v.expires_at };
  } catch { return null; }
}
