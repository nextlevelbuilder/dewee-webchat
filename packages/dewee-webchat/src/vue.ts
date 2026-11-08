// Vue 3 wrapper. Usage: <DeweeChat endpoint="/api/dewee" :show-tool-calls="false" @reply="onReply" />
import { defineComponent, h, onMounted, ref, watch, type PropType } from "vue";
import { defineDeweeChat, type DeweeChatConfig, type DeweeChatElement, type PageAction } from "./index";

const keys = [
  "endpoint", "agent", "title", "subtitle", "greeting", "intro", "placeholder", "suggestions", "avatar", "launcherAvatar",
  "position", "mode", "theme", "accentColor", "locale", "showReasoning", "showToolCalls", "allowAgentSwitch", "open",
  "persist", "hideBranding", "gatewayUrl", "gatewayToken", "width", "height", "zIndex", "actions", "confirm", "getPageContext",
  "maxActionRounds", "actionTimeoutMs", "headers", "fetch", "domActions", "domActionsRoot", "imageOrigins",
] as const;

const props = Object.fromEntries(keys.map((k) => [k, { type: null as unknown as PropType<any>, default: undefined }])) as {
  [K in (typeof keys)[number]]: { type: PropType<any>; default: undefined };
};

const EVENTS = ["ready", "send", "reply", "error", "open", "close", "action"] as const;

export const DeweeChat = defineComponent({
  name: "DeweeChat",
  props,
  emits: [...EVENTS],
  setup(p, { emit, expose }) {
    const el = ref<DeweeChatElement | null>(null);
    const config = (): Partial<DeweeChatConfig> =>
      ({ ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)), imageOrigins: p.imageOrigins ?? [] }) as Partial<DeweeChatConfig>;
    onMounted(() => {
      defineDeweeChat();
      const node = el.value!;
      for (const name of EVENTS) node.addEventListener(`dewee:${name}`, (e) => emit(name, (e as CustomEvent).detail));
      node.configure(config());
    });
    watch(() => ({ ...p }), () => el.value?.configure(config()), { deep: true });
    expose({
      element: el,
      open: () => el.value?.open(),
      close: () => el.value?.close(),
      send: (text: string) => el.value?.send(text),
      newConversation: () => el.value?.newConversation(),
      registerActions: (actions: PageAction | PageAction[]) => el.value?.registerActions(actions),
      unregisterAction: (name: string) => el.value?.unregisterAction(name),
    });
    return () => h("dewee-chat", { ref: el, endpoint: p.endpoint, mode: p.mode });
  },
});

export default DeweeChat;
export type { ActionConfirmHook, ActionEventDetail, DomActionsRoot, PageAction, PageActionContext, RequestHeadersOption } from "./index";
export type { DeweeChatConfig, DeweeChatElement };
