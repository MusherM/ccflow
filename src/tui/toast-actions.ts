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

function tuiToastDuration(type: TuiToastType): number {
  if (type === "loading") return TOAST_DURATION.PERSISTENT;
  if (type === "error") return TOAST_DURATION.LONG;
  return TOAST_DURATION.DEFAULT;
}
