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
  const poll = setInterval(() => { if (popup.closed) cancel(); }, 200);
  window.addEventListener("pagehide", cancel, { once: true });
  let form: HTMLFormElement | undefined;
  let input: HTMLInputElement | undefined;
  try {
    popup.opener = null;
    if (signal?.aborted) cancel();
    const ticket = parseJobAccessLaunch(await Promise.race([load(controller.signal), cancelled]));
    if (popup.closed) throw new JobAccessPopupError("popup_closed");
    if (controller.signal.aborted) throw new JobAccessPopupError("job_access_unavailable");
    form = document.createElement("form");
    form.method = "POST";
    form.action = ticket.bootstrap_url;
    form.target = name;
    form.hidden = true;
    input = document.createElement("input");
    input.type = "hidden";
    input.name = "launch_token";
    input.value = ticket.launch_token;
    form.append(input);
    document.body.append(form);
    // A native form submission serializes synchronously. Remove the transient
    // token-bearing node immediately, without retaining it in HTML or storage.
    HTMLFormElement.prototype.submit.call(form);
    input.value = "";
    ticket.launch_token = "";
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
    clearTimeout(timer);
    clearInterval(poll);
    window.removeEventListener("pagehide", cancel);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort!);
    controller.abort();
  }
}
