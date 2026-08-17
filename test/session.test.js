import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRANSLATION_MODEL,
  FIXED_TARGET_LANGUAGE,
  TRANSLATION_CLIENT_SECRET_URL,
  buildClientSecretRequest,
  createClientSecret,
} from "../src/session.js";

test("buildClientSecretRequest builds the minimal translation payload", () => {
  const request = buildClientSecretRequest({ apiKey: "test-api-key" });

  assert.equal(request.url, TRANSLATION_CLIENT_SECRET_URL);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer test-api-key");
  assert.equal(request.init.headers["Content-Type"], "application/json");

  assert.deepEqual(JSON.parse(request.init.body), {
    session: {
      model: DEFAULT_TRANSLATION_MODEL,
      audio: {
        output: { language: FIXED_TARGET_LANGUAGE },
      },
    },
  });
});

test("buildClientSecretRequest requires an API key", () => {
  assert.throws(() => buildClientSecretRequest({}), /OPENAI_API_KEY/);
});

test("createClientSecret returns only browser-safe session data", async () => {
  const result = await createClientSecret({
    apiKey: "test-api-key",
    fetchImpl: async () =>
      Response.json({
        value: "ek_test",
        expires_at: 1_700_000_600,
        session: { id: "sess_test" },
      }),
  });

  assert.deepEqual(result, {
    client_secret: "ek_test",
    expires_at: 1_700_000_600,
    model: DEFAULT_TRANSLATION_MODEL,
    session: { id: "sess_test" },
    targetLanguage: FIXED_TARGET_LANGUAGE,
  });
});
