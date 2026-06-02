import test from "node:test";
import assert from "node:assert/strict";
import { TOAST_DURATION } from "../src/core/toast.js";
import { emitTuiErrorToast, emitTuiToast, toastStore } from "../src/tui/toast-actions.js";

test.beforeEach(() => {
  toastStore.dismiss();
});

test.afterEach(() => {
  toastStore.dismiss();
});

test("TUI toast helper promotes a loading toast in place", () => {
  const id = emitTuiToast("loading", "creating next node...");

  assert.equal(toastStore.list().length, 1);
  assert.equal(toastStore.list()[0]?.type, "loading");
  assert.equal(toastStore.list()[0]?.duration, TOAST_DURATION.PERSISTENT);

  const promoted = emitTuiToast("success", "Created node_child", {
    id,
    description: "parent commit running",
  });

  const entries = toastStore.list();
  assert.equal(promoted, id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, id);
  assert.equal(entries[0]?.type, "success");
  assert.equal(entries[0]?.message, "Created node_child");
  assert.equal(entries[0]?.description, "parent commit running");
  assert.equal(entries[0]?.duration, TOAST_DURATION.DEFAULT);
});

test("TUI error toast helper stores error detail as a long-lived description", () => {
  const id = emitTuiErrorToast("Action failed", new Error("reset boom"));

  const entry = toastStore.list()[0];
  assert.equal(entry?.id, id);
  assert.equal(entry?.type, "error");
  assert.equal(entry?.message, "Action failed");
  assert.equal(entry?.description, "reset boom");
  assert.equal(entry?.duration, TOAST_DURATION.LONG);
});

test("TUI toast helper supports success, warning, info and loading defaults", () => {
  emitTuiToast("success", "Deleted leaf");
  emitTuiToast("warning", "Merge conflict");
  emitTuiToast("info", "Focus moved to node_root");
  emitTuiToast("loading", "merging...");

  const entries = toastStore.list();
  assert.deepEqual(entries.map((entry) => entry.type), ["success", "warning", "info", "loading"]);
  assert.deepEqual(entries.map((entry) => entry.duration), [
    TOAST_DURATION.DEFAULT,
    TOAST_DURATION.DEFAULT,
    TOAST_DURATION.DEFAULT,
    TOAST_DURATION.PERSISTENT,
  ]);
});
