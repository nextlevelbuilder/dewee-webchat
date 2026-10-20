import { DeweeChatElement, type DeweeChatConfig } from "./widget/element";

export { DeweeChatElement, type DeweeChatConfig };
export { ApiClient, ApiError, type ApiClientOptions } from "./widget/api-client";
export { renderMarkdown } from "./widget/markdown";
export type { ActionManifestEntry, ActionSensitivity, AgentInfo, ChatRequestBody, ChatStreamEvent, HistoryMessage, IdentityErrorCode, LinkResponse, LinkTarget, PublicConfig, Remediation, SessionResponse, ToolCallView } from "./protocol";
export type { ActionCallStatus, ActionConfirmHook, PageAction, PageActionContext, PageActionInfo } from "./actions/action-runner";
export type { ActionResult, ActionResultStatus } from "./actions/directives";
export type { JsonSchema } from "./actions/json-schema-subset";
export type { ActionEventDetail, ActionCallView } from "./widget/element";

/** Registers the `<dewee-chat>` custom element (idempotent, SSR-safe). */
export function defineDeweeChat(tag = "dewee-chat"): void {
  if (typeof window === "undefined" || !window.customElements) return;
  if (!customElements.get(tag)) customElements.define(tag, class extends DeweeChatElement {});
}

/** Creates a widget and appends it to `target` (default: document.body). */
export function mount(config: Partial<DeweeChatConfig> = {}, target?: HTMLElement | string): DeweeChatElement {
  defineDeweeChat();
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  el.configure(config);
  const parent = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  (parent ?? document.body).appendChild(el);
  return el;
}

defineDeweeChat();

declare global {
  interface HTMLElementTagNameMap {
    "dewee-chat": DeweeChatElement;
  }
}
