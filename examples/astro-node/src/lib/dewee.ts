// One dewee-webchat handler per process, CCP transport only. Settings are read from process.env at
// run time (never import.meta.env, which a build could inline into a bundle).
import { createDeweeHandler, optionsFromEnv, type DeweeHandler, type DeweeIdentityOptions } from "dewee-webchat/server";
import { deweeIdentitySdk } from "dewee-webchat/server/identity";
import { currentUser } from "./demo-login";

let handler: DeweeHandler | undefined;

/** Signed-in users when a Dewee identity application is configured; anonymous visitors otherwise. */
function identityOptions(env: NodeJS.ProcessEnv): DeweeIdentityOptions | undefined {
  if (!env.DEWEE_IDENTITY_APP_ID) return undefined;
  return {
    sdk: deweeIdentitySdk,
    // Map the host login to a Dewee subject: the stable user id, never an email address.
    authenticate: async (req) => {
      const user = currentUser(req);
      return user ? { subject: user } : null;
    },
    // A cookie login: a widget token replayed under another user's cookie is refused.
    rebindEachRequest: true,
    appId: env.DEWEE_IDENTITY_APP_ID,
    issuer: env.DEWEE_IDENTITY_ISSUER ?? "",
    assertionSecret: env.DEWEE_IDENTITY_ASSERTION_SECRET,
  };
}

export function dewee(): DeweeHandler {
  // `transport: "ccp"` is pinned: a leftover DEWEE_GATEWAY_URL/TOKEN makes startup fail instead of
  // silently talking to a Gateway.
  return (handler ??= createDeweeHandler(optionsFromEnv(process.env, { transport: "ccp", identity: identityOptions(process.env) })));
}
