import { parseJobAccessLaunch, type JobAccessLaunch } from "../job-access";

export class JobAccessPopupError extends Error {
  constructor(readonly code: "popup_blocked" | "popup_closed" | "job_access_unavailable") {
    super("Job access could not be opened");
  }
}

/** Open during the click, then hand a short-lived ticket to the fixed server-owned destination. */
export async function openJobAccessTicket(load: (signal: AbortSignal) => Promise<JobAccessLaunch>, signal?: AbortSignal): Promise<void> {
  const name = `dewee-job-access-${crypto.randomUUID()}`;
  let popup: Window | null;
  try { popup = window.open("about:blank", name, "popup,width=720,height=800"); }
  catch { throw new JobAccessPopupError("popup_blocked"); }
  if (!popup) throw new JobAccessPopupError("popup_blocked");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new JobAccessPopupError(popup.closed ? "popup_closed" : "job_access_unavailable"));
  });
  controller.signal.addEventListener("abort", rejectAbort!, { once: true });
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 30_000);
  let navigationStarted = false;
  let finishNavigation: (() => void) | undefined;
  let refuseNavigation: (() => void) | undefined;
  const navigation = new Promise<void>((resolve, reject) => {
    finishNavigation = resolve;
    refuseNavigation = () => reject(new JobAccessPopupError("job_access_unavailable"));
  });
  const poll = setInterval(() => {
    if (popup.closed) { cancel(); return; }
    if (!navigationStarted) return;
    try {
      if (popup.location.href !== "about:blank") finishNavigation!();
    } catch {
      // Cross-origin access becomes unavailable when the submitted navigation commits.
      finishNavigation!();
    }
  }, 200);
  window.addEventListener("pagehide", cancel, { once: true });
  let form: HTMLFormElement | undefined;
  let input: HTMLInputElement | undefined;
  let launchDocument: Document | undefined;
  const blocked = (event: SecurityPolicyViolationEvent) => {
    if (event.disposition === "enforce" && (event.effectiveDirective === "form-action" || event.violatedDirective === "form-action")) refuseNavigation!();
  };
  try {
    popup.opener = null;
    if (signal?.aborted) cancel();
    const ticket = parseJobAccessLaunch(await Promise.race([load(controller.signal), cancelled]));
    if (popup.closed) throw new JobAccessPopupError("popup_closed");
    if (controller.signal.aborted) throw new JobAccessPopupError("job_access_unavailable");
    // Submit from the owned blank popup so a host no-referrer policy cannot
    // turn the POST Origin into null. Keep the host document policy unchanged.
    launchDocument = popup.document;
    const referrer = launchDocument.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "strict-origin";
    launchDocument.head.append(referrer);
    form = launchDocument.createElement("form");
    form.method = "POST";
    form.action = ticket.bootstrap_url;
    form.target = "_self";
    form.hidden = true;
    input = launchDocument.createElement("input");
    input.type = "hidden";
    input.name = "launch_token";
    input.value = ticket.launch_token;
    form.append(input);
    launchDocument.body.append(form);
    // A native form submission serializes synchronously. Remove the transient
    // token-bearing node immediately, without retaining it in HTML or storage.
    launchDocument.addEventListener("securitypolicyviolation", blocked);
    HTMLFormElement.prototype.submit.call(form);
    navigationStarted = true;
    input.value = "";
    ticket.launch_token = "";
    form.remove();
    await Promise.race([navigation, cancelled]);
  } catch (error) {
    const closed = popup.closed;
    try { popup.close(); } catch { /* Only this owned popup is closed. */ }
    if (closed) throw new JobAccessPopupError("popup_closed");
    if (error instanceof JobAccessPopupError) throw error;
    // Typed API refusals are already scrubbed by ApiClient.jobAccess.
    throw error;
  } finally {
    if (input) input.value = "";
    form?.remove();
    launchDocument?.removeEventListener("securitypolicyviolation", blocked);
    clearTimeout(timer);
    clearInterval(poll);
    window.removeEventListener("pagehide", cancel);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort!);
    controller.abort();
  }
}
