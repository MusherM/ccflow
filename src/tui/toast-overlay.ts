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
  success: "●",
  error: "◇",
  warning: "◌",
  info: "○",
  loading: "◌",
};

const ACCENTS: Record<ToastType, { bar: string; icon: string; bg: string }> = {
  default: { bar: "#64748b", icon: "#cbd5e1", bg: "#0d1117" },
  success: { bar: "#86efac", icon: "#86efac", bg: "#0d1117" },
  error: { bar: "#fca5a5", icon: "#fca5a5", bg: "#0d1117" },
  warning: { bar: "#fcd34d", icon: "#fcd34d", bg: "#0d1117" },
  info: { bar: "#7dd3fc", icon: "#7dd3fc", bg: "#0d1117" },
  loading: { bar: "#7dd3fc", icon: "#7dd3fc", bg: "#0d1117" },
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
    Text({ content: truncate(entry.message, maxWidth - 6), fg: "#e2e7eb", attributes: TextAttributes.BOLD }),
  );

  const innerChildren: AnyChild[] = [
    Box(
      { flexDirection: "row" },
      ...titleChildren,
    ),
  ];
  if (entry.description) {
    const lines = entry.description.split(/\r?\n/);
    innerChildren.push(
      Box(
        { flexDirection: "column" },
        ...lines.map((line) =>
          Box(
            { flexDirection: "row" },
            Text({ content: "│ ", fg: "#475569" }),
            Text({ content: truncate(line, maxWidth - 8), fg: "#94a3b8" }),
          ),
        ),
      ),
    );
  }

  return Box(
    {
      id: `toast-${entry.id}`,
      backgroundColor: accent.bg,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
      flexDirection: "column",
      width: maxWidth,
      position: "relative",
    },
    Text({
      content: "▌",
      fg: accent.bar,
      position: "absolute",
      left: -1,
      top: 0,
      width: 1,
      height: undefined,
    }),
    ...innerChildren,
  );
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
