import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { buildServer, getListenHost } from "../src/server.js";

async function withServer(options, run) {
  const server = buildServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

test("serves the browser app from the root route", async () => {
  await withServer({ env: { OPENAI_API_KEY: "sk-test" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(body, /Live Event Translator/);
    assert.match(body, /Choose event tab/);
    assert.doesNotMatch(body, /Start translating</);
    assert.doesNotMatch(body, /OpenAI Developers/);
    assert.doesNotMatch(body, /class="topbar"/);
    assert.doesNotMatch(body, /Open a tab that is already playing audio/);
  });
});

test("uses localhost by default and allows the listen host to be configured", () => {
  assert.equal(getListenHost({}), "127.0.0.1");
  assert.equal(getListenHost({ HOST: "0.0.0.0" }), "0.0.0.0");
});

test("fails fast on partial auth configuration", () => {
  assert.throws(
    () =>
      buildServer({
        env: {
          OPENAI_API_KEY: "sk-test",
          APP_AUTH_USERNAME: "demo",
          APP_AUTH_PASSWORD: "secret",
        },
      }),
    /must all be set together/i,
  );
});

test("serves the source speech WAV as audio", async () => {
  await withServer({ env: { OPENAI_API_KEY: "sk-test" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/source-speech.wav`, { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /audio\/wav/);
  });
});

test("serves browser app code that connects to translation over WebRTC", async () => {
  await withServer({ env: { OPENAI_API_KEY: "sk-test" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/app.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /RTCPeerConnection/);
    assert.match(body, /realtime\/translations\/calls/);
    assert.doesNotMatch(body, /new WebSocket/);
    assert.doesNotMatch(body, /audioMix/);
    assert.doesNotMatch(body, /sourceAudio/);
    assert.doesNotMatch(body, /translatedAudio/);
  });
});

test("exposes a health endpoint for deploy checks", async () => {
  await withServer({ env: { OPENAI_API_KEY: "sk-test" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, authEnabled: false });
  });
});

test("requires auth when internal login is configured", async () => {
  const env = {
    OPENAI_API_KEY: "sk-test",
    APP_AUTH_USERNAME: "demo",
    APP_AUTH_PASSWORD: "secret",
    APP_AUTH_SECRET: "super-secret-cookie-key",
  };

  await withServer(
    {
      env,
      fetchImpl: async () =>
        Response.json({
          value: "ek_test",
          expires_at: 123,
          session: { id: "sess_test" },
        }),
    },
    async (baseUrl) => {
      const loginPage = await fetch(`${baseUrl}/`);
      const loginBody = await loginPage.text();
      assert.equal(loginPage.status, 200);
      assert.match(loginBody, /Sign in to continue/);

      const blockedSession = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "es" }),
      });
      const blockedBody = await blockedSession.json();
      assert.equal(blockedSession.status, 401);
      assert.match(blockedBody.error, /authentication required/i);

      const loginResponse = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "demo", password: "secret" }),
      });
      const loginResult = await loginResponse.json();
      const cookie = loginResponse.headers.get("set-cookie") ?? "";
      assert.equal(loginResponse.status, 200);
      assert.equal(loginResult.authenticated, true);
      assert.match(cookie, /meeting_auth=/);

      const authedStatus = await fetch(`${baseUrl}/auth/status`, {
        headers: { cookie: cookie.split(";")[0] },
      });
      const authedStatusBody = await authedStatus.json();
      assert.equal(authedStatusBody.authenticated, true);
      assert.equal(authedStatusBody.username, "demo");

      const authedSession = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: cookie.split(";")[0],
        },
        body: JSON.stringify({ targetLanguage: "es" }),
      });
      const authedSessionBody = await authedSession.json();
      assert.equal(authedSession.status, 200);
      assert.equal(authedSessionBody.client_secret, "ek_test");
    });
});

test("POST /session validates target language before calling OpenAI", async () => {
  let calls = 0;
  await withServer(
    {
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("fetch should not be called");
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "english" }),
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.match(body.error, /language code/i);
      assert.equal(calls, 0);
    },
  );
});

test("POST /session returns a browser-safe client secret response", async () => {
  const requests = [];
  await withServer(
    {
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          value: "ek_test",
          expires_at: 123,
          session: { id: "sess_test" },
        });
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "es" }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, {
        client_secret: "ek_test",
        expires_at: 123,
        model: "gpt-realtime-translate",
        session: { id: "sess_test" },
        session_update: {
          type: "session.update",
          session: {
            audio: {
              input: {
                transcription: { model: "gpt-realtime-whisper" },
                noise_reduction: null,
              },
              output: { language: "es" },
            },
          },
        },
        targetLanguage: "es",
      });
      assert.equal(requests.length, 1);
      const requestBody = JSON.parse(requests[0].init.body);
      assert.equal(requestBody.session.model, "gpt-realtime-translate");
      assert.equal(requestBody.session.audio.output.language, "es");
      assert.deepEqual(requestBody.session.audio.input, {
        transcription: { model: "gpt-realtime-whisper" },
        noise_reduction: null,
      });
    },
  );
});
