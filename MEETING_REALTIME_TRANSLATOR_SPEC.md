# Meeting Realtime Translator Spec

## Goal

Turn the current demo into an internal, account-gated meeting translator that works
for live online meetings in a single active session at a time.

Primary product behavior:

- Capture browser-tab audio from the meeting source.
- Send audio to OpenAI Realtime Translation.
- Show translated captions/transcript live.
- Keep the app stable for the full duration of the active meeting session.
- Do not play translated speech locally.

## Non-Goals

- No public unauthenticated access.
- No long-term transcript archive.
- No voice output playback in the browser.
- No complex multi-tenant admin console in phase 1.

## Current Baseline

The repo already has:

- Browser tab capture and WebRTC translation flow in `src/public/app.js`.
- Server-side client-secret creation in `src/server.js` and `src/session.js`.
- Basic test coverage in `test/*.test.js`.
- A static server and Dockerfile for local/demo deployment.

The current code is still demo-oriented, so it must be hardened before production use.

## Functional Requirements

### 1. Account Gate

- Users must sign in before accessing the app UI.
- Only authenticated users can call `POST /session`.
- Session creation must be tied to the signed-in account.
- The UI should clearly show current account and logout status.

### 2. Meeting Translation Flow

- User selects a browser tab and enables tab audio.
- App establishes a Realtime translation session.
- App displays translated transcript deltas live.
- App shows connection state, capture state, and errors.
- App must not synthesize or play translated speech.

### 3. Session Policy

- The app should treat one active meeting as one session.
- Transcript and event log must reset when the user starts a new window or a new meeting source.
- The app should refresh or re-create translation session before expiration.
- The app should recover cleanly from short network interruptions.

### 4. Operational Readiness

- App must run behind HTTPS on a VPS.
- App must support restart without manual intervention.
- App must expose enough logs for diagnosis, but not store unbounded browser logs.
- App must reject abusive or repeated session creation.

## Data Limits

Because the transcript and log are session-scoped, use reset-on-session-change buffers:

- Transcript buffer: clear on new session.
- Event log: clear on new session.
- Diagnostics history: keep only current state plus recent transitions.

Recommended implementation:

- Use in-memory session state for transcript and event lines.
- Optionally persist only a small rolling audit trail on the server.
- Avoid rendering unlimited DOM nodes for transcript/log output.

## Architecture

### Frontend

- Replace the current audio playback sections in `src/public/app.js`.
- Keep capture, WebRTC, transcript rendering, and status indicators.
- Add auth-aware UI state.
- Add bounded transcript/log rendering.

### Backend

- Keep `POST /session` as the Realtime entry point.
- Add authentication middleware before session creation.
- Add rate limiting and per-account quota checks.
- Add request logging and error logging.

### Deployment

- Run behind Nginx or another reverse proxy with TLS.
- Use environment variables or secret manager for production secrets.
- Add restart policy and health check.
- Add log rotation and disk usage monitoring.

## Event Handling Rules

The client should handle both event families that may appear from the API:

- `session.*`
- `response.*`

The UI should:

- Append translated transcript deltas.
- Ignore unknown events safely.
- Surface error events clearly.
- Preserve the latest connection state after reconnect.

## Recommended Code Changes

### Phase 1: Productize the UI

- Remove translated speech playback.
- Remove audio mix controls.
- Keep transcript, event log, meter, and connection status.
- Add UI for account state and logout.

### Phase 2: Secure the Server

- Add auth gate for `/session`.
- Add rate limiting.
- Add request identity and audit logging.
- Add response headers for production safety.

### Phase 3: Stabilize Long Sessions

- Add session refresh before expiration.
- Add reconnect with exponential backoff.
- Add session reset when the user switches to a new window or meeting source.
- Add recovery when tab sharing stops.

### Phase 4: Production Deploy

- Add production Docker or systemd deployment.
- Add health endpoint.
- Add structured logs.
- Add smoke test for the real meeting flow.

## Implementation Order

1. Remove local speech playback.
2. Add authentication.
3. Add bounded transcript/log buffers.
4. Add session refresh and reconnect logic.
5. Harden deployment for VPS.
6. Add or update tests.

## Acceptance Criteria

The product is ready for internal use when:

- A signed-in user can start a meeting translation session.
- The app stays usable for the full meeting without stale transcript/log carryover.
- The transcript remains readable and bounded.
- `POST /session` cannot be used anonymously.
- The app restarts cleanly on VPS without manual intervention.
- No local translated speech is played back.

## Open Questions

- Which auth method should be used first: Nginx basic auth, email login, or SSO?
- Should transcript state be persisted after refresh, or only kept in memory?
- Do you want audit logs stored locally or sent to a log service?
