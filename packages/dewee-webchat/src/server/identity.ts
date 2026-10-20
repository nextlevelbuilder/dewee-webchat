// `dewee-webchat/server/identity`: the `@dewee/identity` calls the handler needs for signed-in users.
// A separate entry so that `dewee-webchat/server` never references the SDK and hosts that only serve
// anonymous visitors can bundle it without the SDK installed.
//
//   import { createDeweeHandler } from "dewee-webchat/server";
//   import { deweeIdentitySdk } from "dewee-webchat/server/identity";
//   createDeweeHandler({ ..., identity: { sdk: deweeIdentitySdk, authenticate, appId, issuer, assertionSecret } });
import { exchangeSession, startLink } from "@dewee/identity";
import type { DeweeIdentitySdk } from "./handler";

export const deweeIdentitySdk: DeweeIdentitySdk = { exchangeSession, startLink };

export type { DeweeIdentitySdk } from "./handler";
