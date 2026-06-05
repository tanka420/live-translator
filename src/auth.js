import { createHmac, timingSafeEqual } from "node:crypto";

const AUTH_COOKIE_NAME = "meeting_auth";

export function getAuthConfig(env = process.env) {
  const username = env.APP_AUTH_USERNAME;
  const password = env.APP_AUTH_PASSWORD;
  const secret = env.APP_AUTH_SECRET;
  const ttlSeconds = Number.parseInt(env.APP_AUTH_TTL_SECONDS ?? "28800", 10);
  const hasAnyAuthSetting = Boolean(username || password || secret);
  const hasAllAuthSettings = Boolean(username && password && secret);

  if (hasAnyAuthSetting && !hasAllAuthSettings) {
    throw new Error(
      "APP_AUTH_USERNAME, APP_AUTH_PASSWORD, and APP_AUTH_SECRET must all be set together to enable auth.",
    );
  }

  if (!hasAllAuthSettings || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return {
      enabled: false,
      username: null,
      password: null,
      secret: null,
      ttlSeconds: 0,
    };
  }

  return {
    enabled: true,
    username,
    password,
    secret,
    ttlSeconds,
  };
}

export function isAuthEnabled(authConfig) {
  return Boolean(authConfig?.enabled);
}

export function isAuthenticatedRequest(request, authConfig) {
  if (!isAuthEnabled(authConfig)) {
    return true;
  }

  const cookieValue = parseCookieHeader(getRequestHeader(request, "cookie") ?? "")[AUTH_COOKIE_NAME];
  const username = verifyAuthCookieValue(cookieValue, authConfig.secret);
  return username === authConfig.username;
}

export function getAuthenticatedUsername(request, authConfig) {
  if (!isAuthEnabled(authConfig)) {
    return null;
  }

  const cookieValue = parseCookieHeader(getRequestHeader(request, "cookie") ?? "")[AUTH_COOKIE_NAME];
  return verifyAuthCookieValue(cookieValue, authConfig.secret);
}

export async function handleAuthStatusRequest(request, response, authConfig) {
  const authenticated = isAuthenticatedRequest(request, authConfig);
  const username = authenticated ? getAuthenticatedUsername(request, authConfig) : null;
  sendJson(response, 200, {
    enabled: isAuthEnabled(authConfig),
    authenticated,
    username,
  });
}

export async function handleLoginRequest(request, response, authConfig) {
  if (!isAuthEnabled(authConfig)) {
    sendJson(response, 200, {
      enabled: false,
      authenticated: true,
      username: null,
    });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON body." });
    return;
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (username !== authConfig.username || password !== authConfig.password) {
    sendJson(response, 401, { error: "Invalid username or password." });
    return;
  }

  const expiresAt = Date.now() + authConfig.ttlSeconds * 1000;
  const cookieValue = buildAuthCookieValue(username, expiresAt, authConfig.secret);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": buildCookieHeader(cookieValue, expiresAt, request, authConfig.ttlSeconds),
  });
  response.end(JSON.stringify({ authenticated: true, username }));
}

export function handleLogoutRequest(request, response, authConfig) {
  if (!isAuthEnabled(authConfig)) {
    sendJson(response, 200, { authenticated: true });
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": buildClearedCookieHeader(request),
  });
  response.end(JSON.stringify({ authenticated: false }));
}

export function renderLoginPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in</title>
    <style>
      :root { color-scheme: light; --bg: #f6f8fb; --panel: #fff; --ink: #102033; --muted: #5f6f82; --line: #dbe3ec; --accent: #0f8b8d; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(180deg, rgb(226 241 246 / 76%) 0, #f6f8fb 260px), var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(440px, calc(100vw - 32px)); padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 24px 70px rgb(0 0 0 / 6%); }
      p, h1 { margin-top: 0; }
      h1 { margin-bottom: 8px; font-size: 1.6rem; }
      .panel-label { margin-bottom: 12px; color: var(--muted); font-size: 0.72rem; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
      .summary { color: #334155; line-height: 1.5; }
      label { display: block; margin: 16px 0 8px; color: var(--muted); font-size: 0.74rem; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
      input { width: 100%; min-height: 48px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
      button { width: 100%; min-height: 48px; margin-top: 16px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 750; cursor: pointer; }
      .error { min-height: 1.4em; margin-top: 10px; color: #b43224; }
      .hint { margin-top: 14px; color: var(--muted); font-size: 0.92rem; line-height: 1.45; }
    </style>
  </head>
  <body>
    <main>
      <p class="panel-label">Internal access</p>
      <h1>Sign in to continue</h1>
      <p class="summary">Use the internal account to access the live meeting translator.</p>
      <form id="loginForm">
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
        <div id="error" class="error" aria-live="polite"></div>
      </form>
      <p class="hint">After sign-in, the app will load the meeting translator UI.</p>
    </main>
    <script>
      const form = document.querySelector("#loginForm");
      const error = document.querySelector("#error");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        const payload = {
          username: form.username.value,
          password: form.password.value,
        };
        const response = await fetch("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          error.textContent = body.error ?? "Sign in failed.";
          return;
        }
        location.href = "/";
      });
    </script>
  </body>
</html>`;
}

function buildAuthCookieValue(username, expiresAt, secret) {
  const usernameToken = Buffer.from(username, "utf8").toString("base64url");
  const payload = `${usernameToken}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAuthCookieValue(cookieValue, secret) {
  if (typeof cookieValue !== "string" || !cookieValue) {
    return null;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [usernameToken, expiresAtValue, signature] = parts;
  const expiresAt = Number.parseInt(expiresAtValue, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return null;
  }

  const payload = `${usernameToken}.${expiresAt}`;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    return Buffer.from(usernameToken, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function buildCookieHeader(cookieValue, expiresAt, request, ttlSeconds) {
  const secure = isSecureRequest(request);
  return [
    `${AUTH_COOKIE_NAME}=${cookieValue}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${ttlSeconds}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function buildClearedCookieHeader(request) {
  const secure = isSecureRequest(request);
  return [
    `${AUTH_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    `Expires=${new Date(0).toUTCString()}`,
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function isSecureRequest(request) {
  const forwardedProto = getRequestHeader(request, "x-forwarded-proto");
  return forwardedProto === "https";
}

function getRequestHeader(request, name) {
  if (typeof request?.headers?.get === "function") {
    return request.headers.get(name);
  }
  const headers = request?.headers ?? {};
  const direct = headers[name];
  if (typeof direct === "string") {
    return direct;
  }
  const lowerName = name.toLowerCase();
  return headers[lowerName] ?? null;
}

function parseCookieHeader(headerValue) {
  return Object.fromEntries(
    headerValue
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const equalsIndex = part.indexOf("=");
        if (equalsIndex === -1) {
          return [part, ""];
        }
        return [part.slice(0, equalsIndex), part.slice(equalsIndex + 1)];
      }),
  );
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
