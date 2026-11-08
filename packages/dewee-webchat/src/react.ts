// React wrapper. Usage: <DeweeChat endpoint="/api/dewee" showReasoning={false} actions={[...]} />
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";
import { defineDeweeChat, type ActionEventDetail, type DeweeChatConfig, type DeweeChatElement } from "./index";

export interface DeweeChatProps extends Partial<DeweeChatConfig> {
  className?: string;
  style?: CSSProperties;
  onReady?: (e: CustomEvent) => void;
  onSend?: (e: CustomEvent) => void;
  onReply?: (e: CustomEvent) => void;
  onError?: (e: CustomEvent) => void;
  onOpen?: (e: CustomEvent) => void;
  onClose?: (e: CustomEvent) => void;
  /** Page action telemetry (`dewee:action`, detail: ActionEventDetail). */
  onAction?: (e: CustomEvent<ActionEventDetail>) => void;
}

const EVENTS = {
  onReady: "dewee:ready",
  onSend: "dewee:send",
  onReply: "dewee:reply",
  onError: "dewee:error",
  onOpen: "dewee:open",
  onClose: "dewee:close",
  onAction: "dewee:action",
} as const;
type EventProp = keyof typeof EVENTS;

export const DeweeChat = forwardRef<DeweeChatElement | null, DeweeChatProps>(function DeweeChat(props, ref) {
  const el = useRef<DeweeChatElement | null>(null);
  const { className, style, onReady, onSend, onReply, onError, onOpen, onClose, onAction, actions, confirm, getPageContext, headers, fetch, domActionsRoot, imageOrigins, ...config } = props;
  const handlers: Partial<Record<EventProp, (e: CustomEvent<any>) => void>> = { onReady, onSend, onReply, onError, onOpen, onClose, onAction };
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useImperativeHandle(ref, () => el.current!, []);

  const configKey = JSON.stringify({ ...config, imageOrigins: imageOrigins ?? [] });
  useEffect(() => {
    defineDeweeChat();
    el.current?.configure(JSON.parse(configKey));
  }, [configKey]);

  // Functions, handlers and elements cannot go through the JSON config key; they are applied on every render
  // without re-rendering the widget (inline `actions={[...]}` arrays are fine).
  useEffect(() => {
    defineDeweeChat();
    el.current?.configure({ actions, confirm, getPageContext, headers, fetch, domActionsRoot });
  });

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const offs = (Object.keys(EVENTS) as EventProp[]).map((k) => {
      const fn = (e: Event) => handlersRef.current[k]?.(e as CustomEvent);
      node.addEventListener(EVENTS[k], fn);
      return () => node.removeEventListener(EVENTS[k], fn);
    });
    return () => offs.forEach((off) => off());
  }, []);

  // `mode`/`endpoint` as attributes keep SSR markup stable; configure() applies the rest.
  return createElement("dewee-chat", { ref: el, class: className, style, endpoint: config.endpoint, mode: config.mode });
});

export default DeweeChat;
export type { ActionConfirmHook, ActionEventDetail, DomActionsRoot, PageAction, PageActionContext, RequestHeadersOption } from "./index";
export type { DeweeChatConfig, DeweeChatElement };

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "dewee-chat": Record<string, unknown>;
    }
  }
}
