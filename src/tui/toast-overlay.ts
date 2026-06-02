/**
 * Toast overlay — renders a `ToastStore` snapshot into the TUI tree.
 *
 * Position: top-right corner.
 * Stack mode: capped visible count, oldest first.
 * Auto-ticks the store on every build so the overlay stays consistent with
 * whatever duration the TUI loop last called us at.
 */

import { Box, Text, TextAttributes } from "@opentui/core";
import {
  type ToastEntry,
  type ToastStore,
  type ToastType,
} from "../core/toast.js";

// `VChild` is defined in `@opentui/core` internals but not re-exported; we
// only ever push `Box`/`Text` results into these arrays, so `any[]` is safe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChild = any;

export const TOASTER_OVERLAY_ID = "toaster";

export interface ToasterOverlayOptions {
  /** Maximum visible toasts in the stack. Older toasts are dropped first. */
  maxVisible?: number;
  /** Maximum width in columns. Defaults to 48. */
  maxWidth?: number;
  /** Pixel offset from the screen edges. */
  offset?: { top?: number; right?: number };
  /** Override icons per type; pass `false` to disable. */
  icons?: Partial<Record<ToastType, string>> | false;
}

const DEFAULT_ICONS: Record<ToastType, string> = {
  default: "•",
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
  loading: "◌",
};

const ACCENTS: Record<ToastType, { border: string; icon: string; bg: string }> = {
  default: { border: "#475569", icon: "#cbd5e1", bg: "#0f172a" },
  success: { border: "#22c55e", icon: "#22c55e", bg: "#0b1f12" },
  error: { border: "#ef4444", icon: "#ef4444", bg: "#1f0b0b" },
  warning: { border: "#f59e0b", icon: "#facc15", bg: "#1f1505" },
  info: { border: "#3b82f6", icon: "#7dd3fc", bg: "#0a1424" },
  loading: { border: "#7dd3fc", icon: "#7dd3fc", bg: "#0a1424" },
};

/** Build the toaster overlay tree. Call this on every TUI render frame. */
export function buildToasterOverlay(
  store: ToastStore,
  options: ToasterOverlayOptions = {},
) {
  // Expire any stale toasts before we read the snapshot.
  store.tick();

  const maxVisible = options.maxVisible ?? 5;
  const maxWidth = options.maxWidth ?? 48;
  const offsetTop = options.offset?.top ?? 1;
  const offsetRight = options.offset?.right ?? 1;
  const icons = options.icons === false ? null : { ...DEFAULT_ICONS, ...(options.icons ?? {}) };

  const all = store.list();
  const visible = all.slice(-maxVisible);

  if (visible.length === 0) {
    // Render a zero-size placeholder so the id still exists; callers can
    // safely `renderer.root.remove(TOASTER_OVERLAY_ID)` on every frame.
    return Box(
      {
        id: TOASTER_OVERLAY_ID,
        position: "absolute",
        top: offsetTop,
        right: offsetRight,
        width: 0,
        height: 0,
        zIndex: 100,
      },
    );
  }

  return Box(
    {
      id: TOASTER_OVERLAY_ID,
      position: "absolute",
      top: offsetTop,
      right: offsetRight,
      flexDirection: "column",
      gap: 1,
      width: maxWidth,
      zIndex: 100,
    },
    ...visible.map((entry) => toastBox(entry, maxWidth, icons)),
  );
}

function toastBox(
  entry: ToastEntry,
  maxWidth: number,
  icons: Record<ToastType, string> | null,
) {
  const accent = ACCENTS[entry.type];
  const icon = icons ? icons[entry.type] : null;
  const titleChildren: AnyChild[] = [];
  if (icon) {
    titleChildren.push(
      Text({ content: `${icon} `, fg: accent.icon, attributes: TextAttributes.BOLD }),
    );
  }
  titleChildren.push(
    Text({ content: truncate(entry.message, maxWidth - 4), fg: "#e5e7eb", attributes: TextAttributes.BOLD }),
  );

  const innerChildren: AnyChild[] = [
    Box(
      { flexDirection: "row" },
      ...titleChildren,
    ),
  ];
  if (entry.description) {
    innerChildren.push(
      Text({
        content: truncate(entry.description, maxWidth - 6),
        fg: "#94a3b8",
      }),
    );
  }

  return Box(
    {
      id: `toast-${entry.id}`,
      border: true,
      borderStyle: "rounded",
      borderColor: accent.border,
      backgroundColor: accent.bg,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      paddingBottom: 0,
      flexDirection: "column",
      width: maxWidth,
    },
    ...innerChildren,
  );
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
