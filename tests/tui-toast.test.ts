import test from "node:test";
import assert from "node:assert/strict";
import { TOAST_DURATION, ToastStore } from "../src/core/toast.js";
import {
  createToastExpiryScheduler,
  emitTuiErrorToast,
  emitTuiToast,
  toastStore,
} from "../src/tui/toast-actions.js";

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

test("TUI toast expiry scheduler ticks and notifies when the next toast expires", () => {
  let now = 0;
  const store = new ToastStore({ now: () => now });
  const timers: FakeTimer[] = [];
  let renders = 0;

  const scheduler = createToastExpiryScheduler(
    store,
    () => {
      renders += 1;
    },
    {
      now: () => now,
      setTimer: (callback, delay) => {
        const timer: FakeTimer = {
          callback,
          delay,
          cleared: false,
          unrefCalled: false,
          unref() {
            this.unrefCalled = true;
          },
        };
        timers.push(timer);
        return timer as unknown as NodeJS.Timeout;
      },
      clearTimer: (timer) => {
        (timer as unknown as FakeTimer).cleared = true;
      },
    },
  );

  store.add("done", { duration: 100 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delay, 100);
  assert.equal(timers[0]?.unrefCalled, true);

  now = 100;
  timers[0]?.callback();

  assert.equal(store.size(), 0);
  assert.equal(renders, 1);

  scheduler.dispose();
});

test("TUI toast expiry scheduler reschedules when a loading toast is promoted", () => {
  let now = 0;
  const store = new ToastStore({ now: () => now });
  const timers: FakeTimer[] = [];

  const scheduler = createToastExpiryScheduler(store, () => {}, {
    now: () => now,
    setTimer: (callback, delay) => {
      const timer: FakeTimer = {
        callback,
        delay,
        cleared: false,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      (timer as unknown as FakeTimer).cleared = true;
    },
  });

  const id = store.add("loading", { type: "loading", duration: TOAST_DURATION.PERSISTENT });
  assert.equal(timers.length, 0);

  now = 50;
  store.add("done", { id, type: "success", duration: 250 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delay, 250);

  scheduler.dispose();
  assert.equal(timers[0]?.cleared, true);
});

interface FakeTimer {
  callback: () => void;
  delay: number;
  cleared: boolean;
  unrefCalled: boolean;
  unref: () => void;
}
