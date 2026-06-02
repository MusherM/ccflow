import test from "node:test";
import assert from "node:assert/strict";
import {
  TOAST_DURATION,
  ToastStore,
  __resetDefaultToastStore,
  createToastApiFor,
  toastApi,
  toastPromise,
  type ToastEntry,
  type ToastStoreOptions,
} from "../src/core/toast.js";

function makeStore(options: ToastStoreOptions = {}): ToastStore {
  return new ToastStore(options);
}

function clockAt(time: number) {
  let now = time;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: number) => {
      now = value;
    },
  };
}

test("TOAST_DURATION exposes the documented presets", () => {
  assert.equal(TOAST_DURATION.SHORT, 2_000);
  assert.equal(TOAST_DURATION.DEFAULT, 4_000);
  assert.equal(TOAST_DURATION.LONG, 6_000);
  assert.equal(TOAST_DURATION.EXTENDED, 10_000);
  assert.equal(TOAST_DURATION.PERSISTENT, Number.POSITIVE_INFINITY);
});

test("new store is empty and reports size 0", () => {
  const store = makeStore();
  assert.equal(store.size(), 0);
  assert.deepEqual(store.list(), []);
});

test("add returns a stable id and stores message with default duration", () => {
  const clock = clockAt(1_000);
  const store = makeStore({ now: clock.now });
  const id = store.add("hello");
  assert.ok(id.startsWith("t_"), `id should be prefixed with t_, got ${id}`);
  const entries = store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, id);
  assert.equal(entries[0]!.type, "default");
  assert.equal(entries[0]!.message, "hello");
  assert.equal(entries[0]!.duration, TOAST_DURATION.DEFAULT);
  assert.equal(entries[0]!.createdAt, 1_000);
  assert.equal(entries[0]!.expiresAt, 1_000 + TOAST_DURATION.DEFAULT);
  assert.equal(entries[0]!.description, undefined);
  assert.equal(entries[0]!.action, undefined);
});

test("add with explicit type picks the right default duration", () => {
  const store = makeStore();
  const loadingId = store.add("loading...", { type: "loading" });
  const successId = store.add("ok", { type: "success" });
  const errorId = store.add("nope", { type: "error" });
  const infoId = store.add("info", { type: "info" });
  const warningId = store.add("warn", { type: "warning" });

  const entries = store.list();
  const byId = new Map(entries.map((e) => [e.id, e]));
  assert.equal(byId.get(loadingId)!.duration, TOAST_DURATION.PERSISTENT);
  assert.equal(byId.get(successId)!.duration, TOAST_DURATION.DEFAULT);
  assert.equal(byId.get(errorId)!.duration, TOAST_DURATION.LONG);
  assert.equal(byId.get(infoId)!.duration, TOAST_DURATION.DEFAULT);
  assert.equal(byId.get(warningId)!.duration, TOAST_DURATION.DEFAULT);
});

test("add with custom duration overrides the default", () => {
  const store = makeStore();
  const id = store.add("short", { duration: 1_500 });
  assert.equal(store.list()[0]!.duration, 1_500);
  void id;
});

test("add with PERSISTENT duration sets expiresAt to null", () => {
  const store = makeStore();
  const id = store.add("sticky", { duration: TOAST_DURATION.PERSISTENT });
  assert.equal(store.list()[0]!.expiresAt, null);
  void id;
});

test("add stores description and action verbatim", () => {
  const store = makeStore();
  const action = { label: "Undo", onClick: () => undefined };
  const id = store.add("file deleted", {
    description: "moved to trash",
    action,
  });
  const entry = store.list()[0]!;
  assert.equal(entry.description, "moved to trash");
  assert.equal(entry.action, action);
  void id;
});

test("add with same id replaces the existing toast in place", () => {
  const clock = clockAt(5_000);
  const store = makeStore({ now: clock.now });
  const firstId = store.add("first", { id: "shared" });
  const secondId = store.add("second", { id: "shared" });
  assert.equal(firstId, "shared");
  assert.equal(secondId, "shared");
  const entries = store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, "shared");
  assert.equal(entries[0]!.message, "second");
});

test("add preserves insertion order", () => {
  const store = makeStore();
  store.add("a");
  store.add("b");
  store.add("c");
  const messages = store.list().map((e) => e.message);
  assert.deepEqual(messages, ["a", "b", "c"]);
});

test("update on a missing id returns false and emits no change", () => {
  const store = makeStore();
  let changes = 0;
  store.onChange(() => changes++);
  const ok = store.update("missing", { message: "x" });
  assert.equal(ok, false);
  assert.equal(changes, 0);
});

test("update can change message, type, description and duration", () => {
  const clock = clockAt(10_000);
  const store = makeStore({ now: clock.now });
  const id = store.add("hello", { type: "loading" });
  clock.advance(1_000);
  const ok = store.update(id, {
    type: "success",
    message: "world",
    description: "all good",
    duration: 500,
  });
  assert.equal(ok, true);
  const entry = store.list()[0]!;
  assert.equal(entry.type, "success");
  assert.equal(entry.message, "world");
  assert.equal(entry.description, "all good");
  assert.equal(entry.duration, 500);
  // expiresAt should be relative to the *update* time, not creation time.
  assert.equal(entry.expiresAt, clock.now() + 500);
});

test("update with action: null clears the action", () => {
  const store = makeStore();
  const id = store.add("with action", {
    action: { label: "go", onClick: () => undefined },
  });
  assert.ok(store.list()[0]!.action);
  const ok = store.update(id, { action: null });
  assert.equal(ok, true);
  assert.equal(store.list()[0]!.action, undefined);
});

test("update with PERSISTENT duration sets expiresAt to null", () => {
  const store = makeStore();
  const id = store.add("x", { duration: 1_000 });
  store.update(id, { duration: TOAST_DURATION.PERSISTENT });
  assert.equal(store.list()[0]!.expiresAt, null);
});

test("update keeps createdAt stable", () => {
  const store = makeStore();
  const id = store.add("x");
  const createdAt = store.list()[0]!.createdAt;
  store.update(id, { message: "y" });
  assert.equal(store.list()[0]!.createdAt, createdAt);
});

test("dismiss by id removes that single entry and fires the listener", () => {
  const store = makeStore();
  store.add("a");
  const b = store.add("b");
  store.add("c");

  const dismissed: string[] = [];
  store.onDismiss((id) => dismissed.push(id));

  const removed = store.dismiss(b);
  assert.deepEqual(removed, [b]);
  const messages = store.list().map((e) => e.message);
  assert.deepEqual(messages, ["a", "c"]);
  assert.deepEqual(dismissed, [b]);
});

test("dismiss with no id clears every entry and fires for each", () => {
  const store = makeStore();
  const a = store.add("a");
  const b = store.add("b");

  const dismissed: string[] = [];
  store.onDismiss((id) => dismissed.push(id));

  const removed = store.dismiss();
  assert.deepEqual(removed.sort(), [a, b].sort());
  assert.equal(store.size(), 0);
  assert.deepEqual(dismissed.sort(), [a, b].sort());
});

test("dismiss on an empty store is a no-op", () => {
  const store = makeStore();
  assert.deepEqual(store.dismiss(), []);
  assert.deepEqual(store.dismiss("missing"), []);
});

test("dismiss on an unknown id returns [] and fires no listener", () => {
  const store = makeStore();
  let fires = 0;
  store.onDismiss(() => fires++);
  assert.deepEqual(store.dismiss("missing"), []);
  assert.equal(fires, 0);
});

test("tick on an empty store is a no-op", () => {
  const store = makeStore();
  assert.deepEqual(store.tick(), []);
});

test("tick dismisses only the expired entries", () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const expiredId = store.add("expired", { duration: 100 });
  store.add("stays", { duration: 1_000 });
  store.add("sticky", { duration: TOAST_DURATION.PERSISTENT });
  clock.set(150);
  const dismissed = store.tick();
  assert.deepEqual(dismissed, [expiredId]);
  const messages = store.list().map((e) => e.message);
  assert.deepEqual(messages, ["stays", "sticky"]);
});

test("tick fires dismiss listeners for expired toasts", () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const id = store.add("x", { duration: 10 });
  const fired: string[] = [];
  store.onDismiss((d) => fired.push(d));
  clock.set(20);
  store.tick();
  assert.deepEqual(fired, [id]);
});

test("tick that expires nothing fires no listeners", () => {
  const store = makeStore();
  store.add("a", { duration: 100 });
  let fires = 0;
  store.onDismiss(() => fires++);
  store.tick();
  assert.equal(fires, 0);
});

test("tick at exactly the expiry boundary dismisses the toast", () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  store.add("a", { duration: 100 });
  clock.set(100);
  const dismissed = store.tick();
  assert.equal(dismissed.length, 1);
});

test("onDismiss listener can be unsubscribed", () => {
  const store = makeStore();
  const id = store.add("a");
  let fires = 0;
  const off = store.onDismiss(() => fires++);
  off();
  store.dismiss(id);
  assert.equal(fires, 0);
});

test("onChange fires on add, update, dismiss and tick-expiry but not on empty tick", () => {
  const store = makeStore();
  let changes = 0;
  store.onChange(() => changes++);

  store.add("a");
  assert.equal(changes, 1);
  store.add("b");
  assert.equal(changes, 2);
  store.update(store.list()[0]!.id, { message: "A" });
  assert.equal(changes, 3);
  store.dismiss(store.list()[0]!.id);
  assert.equal(changes, 4);

  const id = store.add("c", { duration: 100 });
  assert.equal(changes, 5);
  store.tick();
  assert.equal(changes, 5, "tick with no expiry should not emit change");
  void id;
});

test("onChange listener can be unsubscribed", () => {
  const store = makeStore();
  let fires = 0;
  const off = store.onChange(() => fires++);
  off();
  store.add("a");
  assert.equal(fires, 0);
});

test("add defaults to using Date.now when no clock is provided", () => {
  const realNow = Date.now;
  try {
    let counter = 1_000_000;
    Date.now = () => counter;
    const store = makeStore();
    const id = store.add("a");
    assert.equal(store.list()[0]!.createdAt, counter);
    void id;
  } finally {
    Date.now = realNow;
  }
});

test("toastPromise promotes loading -> success on resolve", async () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const handle = toastPromise(store, Promise.resolve(42), {
    loading: "loading...",
    success: "done with 42",
    error: "failed",
  });
  assert.equal(store.list()[0]!.type, "loading");
  await handle.promise;
  const entry = store.list()[0]!;
  assert.equal(entry.type, "success");
  assert.equal(entry.message, "done with 42");
  assert.equal(entry.duration, TOAST_DURATION.DEFAULT);
});

test("toastPromise promotes loading -> error on reject and rethrows", async () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const err = new Error("boom");
  const handle = toastPromise(store, Promise.reject(err), {
    loading: "loading...",
    success: "ok",
    error: (e) => `failed: ${(e as Error).message}`,
  });
  await assert.rejects(handle.promise, /boom/);
  const entry = store.list()[0]!;
  assert.equal(entry.type, "error");
  assert.equal(entry.message, "failed: boom");
  assert.equal(entry.duration, TOAST_DURATION.LONG);
});

test("toastPromise supports description templates and string messages", async () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const handle = toastPromise(store, Promise.resolve("ok"), {
    loading: "loading",
    success: "done",
    error: "nope",
    description: {
      loading: "spinning up",
      success: (v) => `result: ${v}`,
    },
  });
  await handle.promise;
  const entry = store.list()[0]!;
  assert.equal(entry.type, "success");
  assert.equal(entry.description, "result: ok");
});

test("toastPromise allows success to be a function and error to be a function", async () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const handle = toastPromise(store, Promise.resolve(7), {
    loading: "loading",
    success: (n: number) => `done ${n}`,
    error: (e: unknown) => `err ${(e as Error).message}`,
  });
  await handle.promise;
  assert.equal(store.list()[0]!.message, "done 7");
});

test("createToastApiFor returns shortcuts that share the store", () => {
  const store = makeStore();
  const api = createToastApiFor(store);
  api.success("ok");
  api.error("nope");
  api.warning("careful");
  api.info("fyi");
  api.loading("wait");
  const types = store.list().map((e) => e.type);
  assert.deepEqual(types, ["success", "error", "warning", "info", "loading"]);
  assert.equal(api.list().length, 5);
  assert.equal(api.store(), store);
});

test("createToastApiFor default toast uses type:default", () => {
  const store = makeStore();
  const api = createToastApiFor(store);
  const id = api("hello", { description: "world" });
  const entry = store.list()[0]!;
  assert.equal(entry.type, "default");
  assert.equal(entry.id, id);
  assert.equal(entry.message, "hello");
  assert.equal(entry.description, "world");
});

test("createToastApiFor.dismiss delegates to the store", () => {
  const store = makeStore();
  const api = createToastApiFor(store);
  const a = api("a");
  const b = api("b");
  api.dismiss(a);
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0]!.id, b);
  api.dismiss();
  assert.equal(store.size(), 0);
});

test("toastApi shares a process-wide default store", () => {
  __resetDefaultToastStore();
  toastApi("a");
  toastApi.success("b");
  assert.equal(toastApi.list().length, 2);
  toastApi.dismiss();
  assert.equal(toastApi.list().length, 0);
  __resetDefaultToastStore();
});

test("__resetDefaultToastStore clears the singleton between tests", () => {
  __resetDefaultToastStore();
  toastApi("a");
  assert.equal(toastApi.list().length, 1);
  __resetDefaultToastStore();
  assert.equal(toastApi.list().length, 0);
});

test("end-to-end: loading -> success on resolve", async () => {
  __resetDefaultToastStore();
  const handle = toastPromise(toastApi.store(), Promise.resolve(7), {
    loading: "uploading",
    success: (n) => `uploaded ${n}`,
    error: "failed",
  });
  assert.equal(toastApi.list().length, 1);
  const loadingId = toastApi.list()[0]!.id;
  assert.equal(loadingId, handle.id);
  assert.equal(toastApi.list()[0]!.type, "loading");
  await handle.promise;
  assert.equal(toastApi.list().length, 1);
  const entry = toastApi.list()[0]!;
  assert.equal(entry.id, handle.id);
  assert.equal(entry.type, "success");
  assert.equal(entry.message, "uploaded 7");
});

test("toastStore list() returns a snapshot that does not mutate with later operations", () => {
  const store = makeStore();
  store.add("a");
  const snapshot = store.list();
  store.add("b");
  assert.equal(snapshot.length, 1);
  assert.equal(store.list().length, 2);
});

test("add with description and action survives an update that only changes message", () => {
  const store = makeStore();
  const action = { label: "go", onClick: () => undefined };
  const id = store.add("a", { description: "d", action });
  store.update(id, { message: "b" });
  const entry = store.list()[0]!;
  assert.equal(entry.message, "b");
  assert.equal(entry.description, "d");
  assert.equal(entry.action, action);
});

test("store accepts a custom clock and tick advances against it", () => {
  const clock = clockAt(2_000);
  const store = makeStore({ now: clock.now });
  store.add("x", { duration: 100 });
  clock.advance(99);
  assert.deepEqual(store.tick(), []);
  clock.advance(1);
  assert.equal(store.tick().length, 1);
});

test("update with message: undefined is a no-op for the message", () => {
  const store = makeStore();
  const id = store.add("hello");
  store.update(id, { type: "info" });
  assert.equal(store.list()[0]!.message, "hello");
});

test("list returns readonly array — mutations do not affect the store", () => {
  const store = makeStore();
  store.add("a");
  const snapshot = store.list();
  // @ts-expect-error: push is a runtime mutation we want to assert is harmless
  snapshot.push({ id: "x", type: "default", message: "x", duration: 0, createdAt: 0, expiresAt: null });
  assert.equal(store.size(), 1);
});

test("sequential loading -> success on the same id replaces the toast", () => {
  const clock = clockAt(0);
  const store = makeStore({ now: clock.now });
  const loadingId = store.add("loading", { type: "loading" });
  const successId = store.add("done", { type: "success", id: loadingId });
  assert.equal(successId, loadingId);
  const entries = store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, "success");
});

test("ToastEntry shape includes all required fields", () => {
  const entry: ToastEntry = {
    id: "x",
    type: "info",
    message: "m",
    description: "d",
    duration: 1_000,
    createdAt: 0,
    expiresAt: 1_000,
    action: { label: "ok", onClick: () => undefined },
  };
  // Compile-time assertion is the test; runtime is sanity.
  assert.equal(entry.id, "x");
});
