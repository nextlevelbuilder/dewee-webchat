import { describe, expect, it } from "vitest";
import { parseCredentialRequest, parseCredentialHandoff } from "../src/credential-request";

const id = "0b7e4c1e-2f6a-4d1b-9c3e-5a8f7d6e4b21";
const expiry = new Date(Date.now() + 3_600_000).toISOString();
const card = { id, schema_version: "webchat-credential-request.v1", status: "pending", title: "Connect", purpose: "Provide a key", target: { type: "provider", mode: "create" }, fields: [{ key: "api_key", label: "API key", kind: "secret", required: true }], expires_at: expiry, agent_key: "support", completion: "hosted", resumable: false };

describe("credential request boundary", () => {
  it("rebuilds known metadata and discards unexpected fields", () => {
    const parsed = parseCredentialRequest({ ...card, secret: "not-forwarded", fields: [{ ...card.fields[0], value: "never-forwarded" }] }, "support");
    expect(parsed).toEqual(card);
  });
  it("rejects wrong agent, schema, status, malformed fields and non-hosted requests", () => {
    for (const bad of [{...card, agent_key: "other"}, {...card, schema_version: "other"}, {...card, status: "unknown"}, {...card, completion: "inline"}, {...card, fields: [{...card.fields[0], required: "yes"}]}, {...card, id: "invalid"}]) {
      expect(parseCredentialRequest(bad, "support")).toBeNull();
    }
  });
  it("accepts only a matching id and explicitly trusted HTTPS origin", () => {
    const answer = { credential_request_id: id, url: "https://app.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expires_at: expiry };
    expect(parseCredentialHandoff(answer, id, "https://app.example")).toEqual(answer);
    for (const url of ["https://evil.example/l/x", "http://app.example/l/x", "https://app.example@evil.example/l/x", "https://u:p@app.example/l/x", "javascript:alert(1)"]) {
      expect(parseCredentialHandoff({ ...answer, url }, id, "https://app.example")).toBeNull();
    }
    expect(parseCredentialHandoff(answer, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "https://app.example")).toBeNull();
  });
});
