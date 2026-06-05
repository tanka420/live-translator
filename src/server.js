import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAuthConfig,
  handleAuthStatusRequest,
  handleLoginRequest,
  handleLogoutRequest,
  isAuthEnabled,
  isAuthenticatedRequest,
  renderLoginPage,
} from "./auth.js";
import { createClientSecret, normalizeTargetLanguage } from "./session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PUBLIC_ROOT = path.join(__dirname, "public");
const MAX_JSON_BYTES = 1_000_000;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
};

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function buildServer({
  env = process.env,
  fetchImpl = fetch,
  publicRoot = DEFAULT_PUBLIC_ROOT,
} = {}) {
  const authConfig = getAuthConfig(env);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, {
          ok: true,
          authEnabled: isAuthEnabled(authConfig),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/status") {
        await handleAuthStatusRequest(request, response, authConfig);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/login") {
        await handleLoginRequest(request, response, authConfig);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        handleLogoutRequest(request, response, authConfig);
        return;
      }

      if (request.method === "POST" && url.pathname === "/session") {
        if (isAuthEnabled(authConfig) && !isAuthenticatedRequest(request, authConfig)) {
          sendJson(response, 401, { error: "Authentication required." });
          return;
        }
        await handleSessionRequest(request, response, { env, fetchImpl });
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        if (isAuthEnabled(authConfig) && !isAuthenticatedRequest(request, authConfig)) {
          if (url.pathname === "/" || url.pathname === "/index.html") {
            sendHtml(response, 200, renderLoginPage(), request.method);
            return;
          }
          sendJson(response, 401, { error: "Authentication required." });
          return;
        }

        await serveStatic(url.pathname, response, { method: request.method, publicRoot });
        return;
      }

      sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected server error.";
      sendJson(response, 500, { error: message });
    }
  });
}

export function loadEnvFiles(env = process.env, cwd = process.cwd()) {
  const candidates = [
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadEnvFile(candidate, env);
    }
  }
}

async function handleSessionRequest(request, response, { env, fetchImpl }) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON body.",
    });
    return;
  }

  let targetLanguage;
  try {
    targetLanguage = normalizeTargetLanguage(body.targetLanguage);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid target language.",
    });
    return;
  }

  if (!env.OPENAI_API_KEY) {
    sendJson(response, 500, { error: "OPENAI_API_KEY is not configured." });
    return;
  }

  try {
    const result = await createClientSecret({
      apiKey: env.OPENAI_API_KEY,
      targetLanguage,
      model: env.OPENAI_TRANSLATION_MODEL,
      inputTranscriptionModel: env.OPENAI_INPUT_TRANSCRIPTION_MODEL,
      fetchImpl,
    });
    sendJson(response, 200, result);
  } catch (error) {
    if (error?.name === "OpenAIRequestError") {
      sendJson(response, 502, {
        error: error.message,
        status: error.status,
        details: parseJsonOrText(error.body),
      });
      return;
    }
    throw error;
  }
}

async function serveStatic(urlPath, response, { method, publicRoot }) {
  const filePath = resolvePublicPath(urlPath, publicRoot);
  if (!filePath) {
    sendText(response, 404, "Not found.");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypeFor(filePath),
    ...SECURITY_HEADERS,
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

function resolvePublicPath(urlPath, publicRoot) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolutePath = path.resolve(publicRoot, relativePath);
  const rootWithSeparator = `${path.resolve(publicRoot)}${path.sep}`;

  if (
    absolutePath !== path.resolve(publicRoot) &&
    !absolutePath.startsWith(rootWithSeparator)
  ) {
    return null;
  }

  if (!existsSync(absolutePath)) {
    return null;
  }

  return absolutePath;
}

async function readJson(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BYTES) {
      throw new Error("JSON body is too large.");
    }
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function loadEnvFile(filePath, env) {
  const contents = readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(equalsIndex + 1).trim());
    if (key && env[key] === undefined) {
      env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  response.end(body);
}

function sendHtml(response, status, body, method = "GET") {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
}

function parseJsonOrText(value) {
  if (!value) {
    return "";
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function getListenHost(env = process.env) {
  return env.HOST || "127.0.0.1";
}

if (process.argv[1] === __filename) {
  loadEnvFiles();
  const port = Number.parseInt(process.env.PORT ?? "5173", 10);
  const host = getListenHost(process.env);
  const server = buildServer();

  server.listen(port, host, () => {
    console.log(`Live Event Translator demo listening at http://${host}:${port}`);
  });
}
