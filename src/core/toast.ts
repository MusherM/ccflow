/**
 * Toast — pure-logic core for transient, dismissible notifications.
 *
 * No rendering dependency. The TUI overlay (`src/tui/toast-overlay.ts`)
 * subscribes to a `ToastStore` and renders the current snapshot.
 *
 * API surface is intentionally Sonner-flavoured so the call sites read
 * naturally and future swap to a different renderer is mechanical.
 */

export const TOAST_DURATION = {
  SHORT: 2_000,
  DEFAULT: 4_000,
  LONG: 6_000,
  EXTENDED: 10_000,
  PERSISTENT: Number.POSITIVE_INFINITY,
} as const;

export type ToastDurationPreset = keyof typeof TOAST_DURATION;

export type ToastType =
  | "default"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "loading";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Stable id; passing it again replaces the existing toast. */
  id?: string;
  /** Secondary line shown under the message. */
  description?: string;
  /**
   * Auto-dismiss timeout in ms. `Number.POSITIVE_INFINITY` (or
   * `TOAST_DURATION.PERSISTENT`) keeps the toast until manually dismissed.
   * Loading toasts default to persistent so the caller can promote them.
   */
  duration?: number;
  /** Optional button rendered on the toast. */
  action?: ToastAction;
}

export interface ToastUpdate {
  type?: ToastType;
  message?: string;
  description?: string;
  /** Pass `null` to remove an existing action. */
  action?: ToastAction | null;
  duration?: number;
}

export interface ToastEntry {
  id: string;
  type: ToastType;
  message: string;
  description?: string;
  duration: number;
  createdAt: number;
  /** Absolute timestamp (ms) when the toast should auto-dismiss. */
  expiresAt: number | null;
  action?: ToastAction;
}

export type ToastDismissListener = (id: string) => void;

type ToastListener = () => void;

/** Generate a stable, monotonically-prefixed id without crypto deps. */
let __toastCounter = 0;
function generateId(prefix = "t"): string {
  __toastCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${__toastCounter.toString(36)}`;
}

export interface ToastStoreOptions {
  /** Clock injection; defaults to `Date.now`. */
  now?: () => number;
}

export class ToastStore {
  private readonly entries = new Map<string, ToastEntry>();
  private readonly dismissListeners = new Set<ToastDismissListener>();
  private readonly changeListeners = new Set<ToastListener>();
  private readonly now: () => number;

  constructor(options: ToastStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Current entries in insertion order (oldest first). */
  list(): readonly ToastEntry[] {
    return Array.from(this.entries.values());
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Add a toast, or replace an existing one when `options.id` matches.
   * Returns the toast id.
   */
  add(message: string, options: ToastOptions & { type?: ToastType } = {}): string {
    const type = options.type ?? "default";
    const id = options.id ?? generateId(type === "loading" ? "ld" : "t");
    const duration = options.duration ?? defaultDurationFor(type);
    const createdAt = this.now();
    const expiresAt = Number.isFinite(duration) ? createdAt + duration : null;
    const entry: ToastEntry = {
      id,
      type,
      message,
      description: options.description,
      duration,
      createdAt,
      expiresAt,
      action: options.action,
    };
    this.entries.set(id, entry);
    this.emitChange();
    return id;
  }

  /** Patch an existing toast. Returns true on success. */
  update(id: string, patch: ToastUpdate): boolean {
    const current = this.entries.get(id);
    if (!current) return false;
    const next: ToastEntry = { ...current };
    if (patch.type !== undefined) next.type = patch.type;
    if (patch.message !== undefined) next.message = patch.message;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.action === null) {
      next.action = undefined;
    } else if (patch.action !== undefined) {
      next.action = patch.action;
    }
    if (patch.duration !== undefined) {
      next.duration = patch.duration;
      next.expiresAt = Number.isFinite(patch.duration)
        ? this.now() + patch.duration
        : null;
    }
    this.entries.set(id, next);
    this.emitChange();
    return true;
  }

  /**
   * Dismiss a single toast, or every toast when called with no id.
   * Returns the dismissed ids.
   */
  dismiss(id?: string): string[] {
    if (id === undefined) {
      const all = Array.from(this.entries.keys());
      if (all.length === 0) return all;
      this.entries.clear();
      this.emitChange();
      for (const dismissed of all) this.dismissListeners.forEach((l) => l(dismissed));
      return all;
    }
    if (!this.entries.has(id)) return [];
    this.entries.delete(id);
    this.emitChange();
    this.dismissListeners.forEach((l) => l(id));
    return [id];
  }

  /**
   * Expire any toast whose deadline has passed. Returns the ids that were
   * dismissed. The caller drives the clock — there is no internal timer.
   */
  tick(): string[] {
    if (this.entries.size === 0) return [];
    const now = this.now();
    const expired: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(id);
        expired.push(id);
        this.dismissListeners.forEach((l) => l(id));
      }
    }
    if (expired.length > 0) this.emitChange();
    return expired;
  }

  /** Subscribe to dismiss events. Returns an unsubscribe function. */
  onDismiss(listener: ToastDismissListener): () => void {
    this.dismissListeners.add(listener);
    return () => this.dismissListeners.delete(listener);
  }

  /** Subscribe to any state change (add/update/dismiss/tick). */
  onChange(listener: ToastListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const l of this.changeListeners) l();
  }
}

function defaultDurationFor(type: ToastType): number {
  if (type === "loading") return TOAST_DURATION.PERSISTENT;
  if (type === "error") return TOAST_DURATION.LONG;
  if (type === "success") return TOAST_DURATION.DEFAULT;
  return TOAST_DURATION.DEFAULT;
}

export interface ToastPromiseMessages<T> {
  loading: string;
  success: string | ((value: T) => string);
  error: string | ((reason: unknown) => string);
  description?: {
    loading?: string;
    success?: string | ((value: T) => string);
    error?: string | ((reason: unknown) => string);
  };
}

export interface ToastPromiseHandle {
  id: string;
  promise: Promise<unknown>;
}

function formatTemplate<T>(
  template: string | ((value: T) => string),
  value: T,
): string {
  return typeof template === "function" ? template(value) : template;
}

/**
 * Show loading → success/error toasts for a promise. Returns a handle with
 * the loading toast id and the underlying promise, so callers can dismiss
 * the loading state manually if needed.
 */
export function toastPromise<T>(
  store: ToastStore,
  promise: Promise<T>,
  messages: ToastPromiseMessages<T>,
): ToastPromiseHandle {
  const id = store.add(messages.loading, { type: "loading" });
  const tracked = promise.then(
    (value) => {
      store.update(id, {
        type: "success",
        message: formatTemplate(messages.success, value),
        description: messages.description?.success
          ? formatTemplate(messages.description.success, value)
          : undefined,
        duration: TOAST_DURATION.DEFAULT,
      });
      return value;
    },
    (reason: unknown) => {
      store.update(id, {
        type: "error",
        message: formatTemplate(messages.error, reason),
        description: messages.description?.error
          ? formatTemplate(messages.description.error, reason)
          : undefined,
        duration: TOAST_DURATION.LONG,
      });
      throw reason;
    },
  );
  return { id, promise: tracked };
}

let defaultStore: ToastStore | null = null;
function getDefaultStore(): ToastStore {
  if (!defaultStore) defaultStore = new ToastStore();
  return defaultStore;
}

/** Test-only: reset the default store. */
export function __resetDefaultToastStore(): void {
  defaultStore = null;
}

/** Show a toast on the default global store. */
export function toast(message: string, options?: ToastOptions): string {
  return getDefaultStore().add(message, options);
}

export interface ToastShortcutApi {
  (message: string, options?: ToastOptions): string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  loading: (message: string, options?: ToastOptions) => string;
  promise: <T>(promise: Promise<T>, messages: ToastPromiseMessages<T>) => ToastPromiseHandle;
  dismiss: (id?: string) => string[];
  /** Read-only snapshot of the current default store entries. */
  list: () => readonly ToastEntry[];
  /** Access the singleton store (e.g. to subscribe). */
  store: () => ToastStore;
}

function makeShortcut(
  getStore: () => ToastStore,
  type: Exclude<ToastType, "default">,
) {
  return (message: string, options: ToastOptions = {}): string =>
    getStore().add(message, { ...options, type });
}

function createToastApi(getStore: () => ToastStore): ToastShortcutApi {
  const api = ((message: string, options?: ToastOptions) =>
    getStore().add(message, options ?? {})) as ToastShortcutApi;
  api.success = makeShortcut(getStore, "success");
  api.error = makeShortcut(getStore, "error");
  api.warning = makeShortcut(getStore, "warning");
  api.info = makeShortcut(getStore, "info");
  api.loading = makeShortcut(getStore, "loading");
  api.promise = <T>(promise: Promise<T>, messages: ToastPromiseMessages<T>) =>
    toastPromise(getStore(), promise, messages);
  api.dismiss = (id?: string) => getStore().dismiss(id);
  api.list = () => getStore().list();
  api.store = () => getStore();
  return api;
}

/** Default global toast API bound to the default singleton store. */
export const toastApi: ToastShortcutApi = createToastApi(getDefaultStore);

/** Build a toast API bound to an explicit store (handy in tests). */
export function createToastApiFor(store: ToastStore): ToastShortcutApi {
  return createToastApi(() => store);
}
