import assert from "node:assert/strict";
import test from "node:test";

import { getSessionRefreshDelay } from "../src/public/session-timing.js";

test("getSessionRefreshDelay converts Unix seconds to milliseconds", () => {
  const nowMs = 1_700_000_000_000;
  const expiresAtSeconds = 1_700_000_600;

  assert.equal(getSessionRefreshDelay(expiresAtSeconds, nowMs), 540_000);
});

test("getSessionRefreshDelay also accepts millisecond timestamps", () => {
  const nowMs = 1_700_000_000_000;
  const expiresAtMs = nowMs + 600_000;

  assert.equal(getSessionRefreshDelay(expiresAtMs, nowMs), 540_000);
});

test("getSessionRefreshDelay rejects invalid expiry values", () => {
  assert.equal(getSessionRefreshDelay(null), null);
  assert.equal(getSessionRefreshDelay(Number.NaN), null);
});
