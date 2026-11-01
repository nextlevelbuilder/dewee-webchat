// Backend for the widget: /api/dewee/{config,session,chat,history,link}. The integration secret and the
// identity assertion secret stay in this Node process; the browser only sees sealed visitor tokens.
import type { APIRoute } from "astro";
import { dewee } from "../../../lib/dewee";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => dewee()(request);
