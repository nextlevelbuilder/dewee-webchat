// The staging environment check. On a staging run it gates everything else (scripts/run-staging.mjs);
// on a fake run it checks the check itself. Messages name variables, never their values.
import { describe, expect, it } from "vitest";
import { STAGING, stagingProblems } from "../src/target";

const VALID = {
  DEWEE_CCP_CHAT_URL: "https://ccp.staging.example/api/public/webchat/v1/wci_abcdefghijklmnopqrstuvwxyz",
  DEWEE_WEBCHAT_INTEGRATION_ID: "wci_abcdefghijklmnopqrstuvwxyz",
  DEWEE_WEBCHAT_INTEGRATION_SECRET: "dwc_example_only_not_a_real_secret_value",
  DEWEE_SMOKE_VISITOR_ORIGIN: "https://shop.staging.example",
};

describe.runIf(STAGING)("staging environment", () => {
  it("has every variable the staging smoke needs, and no Gateway credentials", () => {
    const problems = stagingProblems();
    expect(problems, `Staging smoke environment is incomplete:\n- ${problems.join("\n- ")}`).toEqual([]);
  });
});

describe.skipIf(STAGING)("staging environment check", () => {
  it("accepts a complete CCP environment", () => {
    expect(stagingProblems(VALID)).toEqual([]);
  });

  it("names missing and malformed variables without echoing values", () => {
    const problems = stagingProblems({
      ...VALID,
      DEWEE_CCP_CHAT_URL: "http://ccp.staging.example/v1/chat",
      DEWEE_WEBCHAT_INTEGRATION_SECRET: "pk_public_value_in_the_wrong_place",
      DEWEE_SMOKE_VISITOR_ORIGIN: undefined,
    });
    expect(problems).toEqual([
      "DEWEE_SMOKE_VISITOR_ORIGIN is not set",
      expect.stringContaining("DEWEE_CCP_CHAT_URL must be"),
      expect.stringContaining("DEWEE_WEBCHAT_INTEGRATION_SECRET must be the private dwc_"),
    ]);
    expect(problems.join("\n")).not.toContain("pk_public_value_in_the_wrong_place");
  });

  it("refuses legacy Gateway credentials and a mismatched integration id", () => {
    const problems = stagingProblems({ ...VALID, DEWEE_WEBCHAT_INTEGRATION_ID: "wci_zzzzzzzzzzzzzzzzzzzzzzzzzz", DEWEE_GATEWAY_TOKEN: "x" });
    expect(problems).toContain("DEWEE_WEBCHAT_INTEGRATION_ID does not match the id in DEWEE_CCP_CHAT_URL");
    expect(problems).toContain("DEWEE_GATEWAY_TOKEN is set: the CCP smoke must not see legacy Gateway credentials");
  });

  it("checks the identity settings only when an identity application is configured", () => {
    expect(stagingProblems({ ...VALID, DEWEE_IDENTITY_APP_ID: "not-a-uuid" })).toEqual([
      "DEWEE_IDENTITY_APP_ID must be the application UUID",
      "DEWEE_IDENTITY_ISSUER is not set",
      "DEWEE_IDENTITY_ASSERTION_SECRET is not set or shorter than 32 characters",
    ]);
  });
});
