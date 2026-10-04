type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type InstallState = { installed: boolean; available: boolean; busy: boolean; error: string };

let state: InstallState = { installed: false, available: false, busy: false, error: "" };
let prompt: InstallPrompt | null = null;
let started = false;
const listeners = new Set<() => void>();
const publish = (patch: Partial<InstallState>) => {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
};

/** Start at the entrypoint so prompts are captured even while settings are closed.
 * No service worker, persistent install flag, caching, or background work.
 */
export function startInstallTracking() {
  if (started) return;
  started = true;
  const standalone = window.matchMedia("(display-mode: standalone)");
  const isStandalone = () => standalone.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  publish({ installed: isStandalone() });
  standalone.addEventListener("change", () => {
    if (isStandalone()) { prompt = null; publish({ installed: true, available: false }); }
  });
  window.addEventListener("beforeinstallprompt", event => {
    if (state.installed) return;
    event.preventDefault();
    prompt = event as InstallPrompt;
    publish({ available: true, error: "" });
  });
  window.addEventListener("appinstalled", () => {
    prompt = null;
    publish({ installed: true, available: false, error: "" });
  });
}

export const pwaInstall = {
  snapshot: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async install() {
    const pending = prompt;
    if (!pending || state.busy || state.installed) return;
    prompt = null;
    publish({ available: false, busy: true, error: "" });
    try {
      // Called directly from the click handler to retain browser user activation.
      await pending.prompt();
      await pending.userChoice;
    } catch {
      publish({ error: "Could not open the install prompt. Use your browser’s install menu instead." });
    } finally {
      publish({ busy: false });
    }
  },
};
