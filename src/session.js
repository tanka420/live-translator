export const DEFAULT_TRANSLATION_MODEL = "gpt-realtime-translate";
export const FIXED_TARGET_LANGUAGE = "vi";
export const TRANSLATION_CLIENT_SECRET_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";

export function buildClientSecretRequest({
  apiKey,
  model = DEFAULT_TRANSLATION_MODEL,
}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const body = {
    session: {
      model,
      audio: {
        output: { language: FIXED_TARGET_LANGUAGE },
      },
    },
  };

  return {
    url: TRANSLATION_CLIENT_SECRET_URL,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    targetLanguage: FIXED_TARGET_LANGUAGE,
    model,
  };
}

export async function createClientSecret({
  apiKey,
  model,
  fetchImpl = fetch,
}) {
  const request = buildClientSecretRequest({
    apiKey,
    model,
  });

  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) {
    throw new OpenAIRequestError(
      response.status,
      await readResponseBodySafely(response),
    );
  }

  const data = await response.json();
  if (!data || typeof data.value !== "string") {
    throw new Error("OpenAI did not return a client secret value.");
  }

  return {
    client_secret: data.value,
    expires_at: data.expires_at ?? null,
    model: request.model,
    session: data.session ?? null,
    targetLanguage: request.targetLanguage,
  };
}

export class OpenAIRequestError extends Error {
  constructor(status, body) {
    super(`OpenAI request failed with status ${status}.`);
    this.name = "OpenAIRequestError";
    this.status = status;
    this.body = body;
  }
}

async function readResponseBodySafely(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
