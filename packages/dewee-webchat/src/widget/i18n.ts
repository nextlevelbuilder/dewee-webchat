import type { AdmissionErrorCode, IdentityErrorCode, LinkErrorCode } from "../protocol";

export interface Strings {
  title: string;
  greeting: string;
  greetingBody: string;
  placeholder: string;
  send: string;
  stop: string;
  newChat: string;
  close: string;
  open: string;
  thinking: string;
  thoughtFor: (s: number) => string;
  reasoning: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;
  args: string;
  result: string;
  online: string;
  poweredBy: string;
  errorGeneric: string;
  stopped: string;
  actionStatus: Record<"pending" | "awaiting-confirmation" | "running" | "done" | "denied" | "error", string>;
  confirmTitle: string;
  confirmDestructive: string;
  allow: string;
  deny: string;
  actionLimit: (n: number) => string;
  /** Shown for the typed identity errors of a signed-in chat. */
  identityErrors: Record<IdentityErrorCode, string>;
  /** Shown when the gateway refuses a message (policy, rate limit, reserved challenge). */
  admissionErrors: Record<AdmissionErrorCode, string>;
  /** Visible countdown while sending is paused after a rate limit. */
  cooldown: (seconds: number) => string;
  /** Announced (aria-live) when the pause starts and when it ends. */
  cooldownStart: (seconds: number) => string;
  cooldownOver: string;
  /** Shown when starting a link fails for a reason other than an identity error. */
  linkErrors: Record<LinkErrorCode, string>;
  linkIntro: string;
  linkContinueOn: (channel: string) => string;
  linkExpires: (minutes: number) => string;
  linkNoTargets: string;
  jobAccess: string;
  jobAccessOpened: string;
  jobAccessUnavailable: string;
  jobAccessPopupBlocked: string;
  jobAccessPopupClosed: string;
}

const en: Strings = {
  title: "Assistant",
  greeting: "Hi there 👋",
  greetingBody: "Ask me anything. I can look things up and use tools to help you.",
  placeholder: "Type a message…",
  send: "Send",
  stop: "Stop",
  newChat: "New conversation",
  close: "Close chat",
  open: "Open chat",
  thinking: "Thinking…",
  thoughtFor: (s) => `Thought for ${s}s`,
  reasoning: "Reasoning",
  toolRunning: "running",
  toolDone: "done",
  toolError: "error",
  args: "Arguments",
  result: "Result",
  online: "Online",
  poweredBy: "Powered by",
  errorGeneric: "Something went wrong. Please try again.",
  stopped: "Stopped.",
  actionStatus: { pending: "queued", "awaiting-confirmation": "needs approval", running: "running", done: "done", denied: "declined", error: "failed" },
  confirmTitle: "Allow this action?",
  confirmDestructive: "This can't be undone.",
  allow: "Allow",
  deny: "Deny",
  actionLimit: (n) => `Stopped after ${n} automatic action rounds. Send a message to continue.`,
  identityErrors: {
    IDENTITY_REQUIRED: "Please sign in to chat.",
    IDENTITY_LINK_REQUIRED: "Link your chat account to continue.",
    IDENTITY_CONFLICT: "This chat account is already linked to another user. Unlink it there first.",
    LINK_EXPIRED: "Your session expired. Send your message again.",
    LINK_REVOKED: "Your access has ended. Sign in again to continue.",
    PERMISSION_DENIED: "You don't have access to this.",
    SOURCE_UNAVAILABLE: "We couldn't check your sign-in right now. Please try again shortly.",
  },
  admissionErrors: {
    POLICY_DENIED: "This message can't be sent. Try shortening or rephrasing it.",
    RATE_LIMITED: "You're sending messages too quickly.",
    CHALLENGE_REQUIRED: "Extra verification is needed. Please try again later.",
  },
  cooldown: (s) => `You can send again in ${s}s`,
  cooldownStart: (s) => `Sending is paused. You can send again in ${s} second${s === 1 ? "" : "s"}.`,
  cooldownOver: "You can send messages again.",
  linkErrors: {
    idempotency_key_reused: "This link request was already used. Please try again.",
    link_in_progress: "A link is already in progress. Use the code you got, or wait for it to expire.",
    linking_unavailable: "Linking is not available right now. Please try again later.",
  },
  linkIntro: "Send this code in a direct message from the chat account you want to link:",
  linkContinueOn: (channel) => `Continue on ${channel}`,
  linkExpires: (m) => `The code expires in ${m} min.`,
  linkNoTargets: "No chat app is set up for linking yet.",
  jobAccess: "Job access",
  jobAccessOpened: "Job access opened in a new window. Review and confirm any permissions there.",
  jobAccessUnavailable: "Job access could not be opened. Sign in again or retry.",
  jobAccessPopupBlocked: "Allow popups for this site, then choose Job access again.",
  jobAccessPopupClosed: "The window was closed. Choose Job access again to retry.",
};

const vi: Strings = {
  title: "Trợ lý",
  greeting: "Xin chào 👋",
  greetingBody: "Bạn cần hỏi gì cứ nhắn nhé. Mình có thể tra cứu và dùng công cụ để hỗ trợ bạn.",
  placeholder: "Nhập tin nhắn…",
  send: "Gửi",
  stop: "Dừng",
  newChat: "Cuộc trò chuyện mới",
  close: "Đóng khung chat",
  open: "Mở khung chat",
  thinking: "Đang suy nghĩ…",
  thoughtFor: (s) => `Đã suy nghĩ ${s} giây`,
  reasoning: "Suy luận",
  toolRunning: "đang chạy",
  toolDone: "xong",
  toolError: "lỗi",
  args: "Tham số",
  result: "Kết quả",
  online: "Đang trực tuyến",
  poweredBy: "Vận hành bởi",
  errorGeneric: "Có lỗi xảy ra. Bạn thử lại giúp mình nhé.",
  stopped: "Đã dừng.",
  actionStatus: { pending: "chờ", "awaiting-confirmation": "cần xác nhận", running: "đang chạy", done: "xong", denied: "đã từ chối", error: "lỗi" },
  confirmTitle: "Cho phép thao tác này?",
  confirmDestructive: "Thao tác này không thể hoàn tác.",
  allow: "Cho phép",
  deny: "Từ chối",
  actionLimit: (n) => `Đã dừng sau ${n} lượt thao tác tự động. Gửi tin nhắn để tiếp tục.`,
  identityErrors: {
    IDENTITY_REQUIRED: "Bạn đăng nhập để trò chuyện nhé.",
    IDENTITY_LINK_REQUIRED: "Bạn cần liên kết tài khoản chat để tiếp tục.",
    IDENTITY_CONFLICT: "Tài khoản chat này đã liên kết với người dùng khác. Hãy hủy liên kết ở đó trước.",
    LINK_EXPIRED: "Phiên đăng nhập đã hết hạn. Bạn gửi lại tin nhắn giúp mình nhé.",
    LINK_REVOKED: "Quyền truy cập của bạn đã kết thúc. Hãy đăng nhập lại để tiếp tục.",
    PERMISSION_DENIED: "Bạn không có quyền thực hiện việc này.",
    SOURCE_UNAVAILABLE: "Hiện chưa kiểm tra được đăng nhập của bạn. Bạn thử lại sau ít phút nhé.",
  },
  admissionErrors: {
    POLICY_DENIED: "Không gửi được tin nhắn này. Bạn thử rút gọn hoặc diễn đạt lại nhé.",
    RATE_LIMITED: "Bạn đang gửi tin nhắn hơi nhanh.",
    CHALLENGE_REQUIRED: "Cần xác minh thêm. Bạn thử lại sau nhé.",
  },
  cooldown: (s) => `Bạn có thể gửi lại sau ${s} giây`,
  cooldownStart: (s) => `Tạm dừng gửi tin nhắn. Bạn có thể gửi lại sau ${s} giây.`,
  cooldownOver: "Bạn có thể gửi tin nhắn tiếp rồi.",
  linkErrors: {
    idempotency_key_reused: "Yêu cầu liên kết này đã được dùng. Bạn thử lại nhé.",
    link_in_progress: "Đang có một liên kết chưa hoàn tất. Hãy dùng mã đã nhận hoặc chờ mã hết hạn.",
    linking_unavailable: "Hiện chưa thể liên kết. Bạn thử lại sau nhé.",
  },
  linkIntro: "Gửi mã này trong tin nhắn riêng từ tài khoản chat bạn muốn liên kết:",
  linkContinueOn: (channel) => `Tiếp tục trên ${channel}`,
  linkExpires: (m) => `Mã hết hạn sau ${m} phút.`,
  linkNoTargets: "Chưa có ứng dụng chat nào được thiết lập để liên kết.",
  jobAccess: "Quyền công việc",
  jobAccessOpened: "Đã mở cửa sổ quyền công việc. Hãy xem lại và xác nhận quyền tại đó.",
  jobAccessUnavailable: "Chưa mở được quyền công việc. Hãy đăng nhập lại hoặc thử lại.",
  jobAccessPopupBlocked: "Cho phép cửa sổ bật lên cho trang này rồi chọn Quyền công việc lần nữa.",
  jobAccessPopupClosed: "Cửa sổ đã đóng. Chọn Quyền công việc lần nữa để thử lại.",
};

export const locales: Record<string, Strings> = { en, vi };

export function pickStrings(locale?: string): Strings {
  const l = (locale || (typeof document !== "undefined" ? document.documentElement.lang : "") || (typeof navigator !== "undefined" ? navigator.language : "") || "en").toLowerCase();
  return l.startsWith("vi") ? vi : en;
}

export const icons = {
  jobAccess: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/></svg>`,
  action: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.1A8.5 8.5 0 1 1 21 12Z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  newChat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
  brain: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2Z"/></svg>`,
  tool: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/></svg>`,
};
