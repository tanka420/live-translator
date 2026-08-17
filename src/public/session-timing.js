const MIN_REFRESH_DELAY_MS = 30_000;
const REFRESH_EARLY_MS = 60_000;
const UNIX_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export function getSessionRefreshDelay(expiresAt, nowMs = Date.now()) {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return null;
  }

  const expiresAtMs =
    expiresAt < UNIX_MILLISECONDS_THRESHOLD ? expiresAt * 1000 : expiresAt;

  return Math.max(
    MIN_REFRESH_DELAY_MS,
    expiresAtMs - nowMs - REFRESH_EARLY_MS,
  );
}
