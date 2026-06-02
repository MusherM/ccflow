import { TOAST_DURATION, ToastStore, type ToastType } from "../core/toast.js";
import type { CcflowNode } from "../core/types.js";

/** Module-level store: toasts outlive a single TUI frame. */
export const toastStore: ToastStore = new ToastStore();

export type TuiToastType = Exclude<ToastType, "default">;

export interface TuiToastOptions {
  id?: string;
  description?: string;
  duration?: number;
}

type ToastTimerHandle = number | NodeJS.Timeout;

export interface ToastExpiryScheduler {
  refresh: () => void;
  dispose: () => void;
}

export interface ToastExpirySchedulerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ToastTimerHandle;
  clearTimer?: (handle: ToastTimerHandle) => void;
}

export function emitTuiToast(type: TuiToastType, message: string, options: TuiToastOptions = {}): string {
  const duration = options.duration ?? tuiToastDuration(type);
  return toastStore.add(message, {
    id: options.id,
    type,
    description: options.description,
    duration,
  });
}

export function emitTuiErrorToast(message: string, error: unknown, id?: string): string {
  return emitTuiToast("error", message, { id, description: formatUnknownError(error) });
}

export function isToastStillLoading(id: string): boolean {
  return toastStore.list().some((entry) => entry.id === id && entry.type === "loading");
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mergeToastDescription(node: CcflowNode): string {
  return node.conflictFiles?.length ? node.conflictFiles.join(", ") : node.id;
}

export function createToastExpiryScheduler(
  store: ToastStore,
  onExpire: () => void,
  options: ToastExpirySchedulerOptions = {},
): ToastExpiryScheduler {
  const now = options.now ?? Date.now;
  const setTimer: (callback: () => void, delay: number) => ToastTimerHandle =
    options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer: (handle: ToastTimerHandle) => void =
    options.clearTimer ?? ((handle) => clearTimeout(handle));
  let timer: ToastTimerHandle | null = null;
  let disposed = false;

  const clear = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const refresh = () => {
    clear();
    if (disposed) return;

    let nextExpiresAt: number | null = null;
    for (const entry of store.list()) {
      if (entry.expiresAt === null) continue;
      if (nextExpiresAt === null || entry.expiresAt < nextExpiresAt) {
        nextExpiresAt = entry.expiresAt;
      }
    }
    if (nextExpiresAt === null) return;

    const nextTimer = setTimer(() => {
      timer = null;
      if (disposed) return;
      const expired = store.tick();
      if (expired.length > 0) onExpire();
      refresh();
    }, Math.max(0, nextExpiresAt - now()));
    if (typeof nextTimer !== "number") nextTimer.unref?.();
    timer = nextTimer;
  };

  const unsubscribe = store.onChange(refresh);
  refresh();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      clear();
      unsubscribe();
    },
  };
}

function tuiToastDuration(type: TuiToastType): number {
  if (type === "loading") return TOAST_DURATION.PERSISTENT;
  if (type === "error") return TOAST_DURATION.LONG;
  return TOAST_DURATION.DEFAULT;
}
