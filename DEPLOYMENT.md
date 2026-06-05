# VPS Deployment Guide

This guide deploys the app from GitHub to a VPS at:

- `translator.songdailong.com`

The goal is to keep this service isolated from existing WordPress sites on the
same VPS.

## 1. GitHub Repository

Use the public repository as the source of truth:

- `https://github.com/tanka420/live-translator`

Recommended workflow:

1. Push changes to GitHub.
2. On the VPS, `git pull` the repository.
3. Restart only the translator service.

## 2. DNS

Create an `A` record:

- Host: `translator`
- Type: `A`
- Value: your VPS public IP

Wait for DNS propagation before issuing TLS certificates.

## 3. Directory Layout

Keep the translator app separate from WordPress paths.

Recommended location:

```text
/srv/live-translator
```

Keep these separate from existing WordPress directories:

- WordPress code
- WordPress uploads
- PHP-FPM sockets
- Shared `.env` files

## 4. Runtime Model

Preferred runtime:

- `Docker` if you want the cleanest isolation
- `systemd` if you prefer native service management

The app should listen on:

- `127.0.0.1:5173` when behind Nginx on the host
- or an internal Docker network port

Do not expose port `5173` directly to the public internet.

## 5. Environment File

Create a production `.env` file on the VPS, outside version control.

Required values:

```bash
OPENAI_API_KEY=...
OPENAI_TRANSLATION_MODEL=gpt-realtime-translate
OPENAI_INPUT_TRANSCRIPTION_MODEL=gpt-realtime-whisper
HOST=0.0.0.0
PORT=5173
APP_AUTH_USERNAME=...
APP_AUTH_PASSWORD=...
APP_AUTH_SECRET=...
APP_AUTH_TTL_SECONDS=28800
```

Notes:

- `HOST=0.0.0.0` is required if the app runs in Docker.
- If the app runs behind Nginx on the host, the container can still bind only
  to the internal interface depending on your runtime model.

## 6. Docker Deployment

Build:

```bash
docker build -t live-translator .
```

Run:

```bash
docker run -d \
  --name live-translator \
  --restart unless-stopped \
  -p 127.0.0.1:5173:5173 \
  --env-file /srv/live-translator/.env \
  live-translator
```

Check health:

```bash
curl http://127.0.0.1:5173/healthz
```

## 7. Nginx Reverse Proxy

Create a dedicated server block for `translator.songdailong.com`.

Example:

```nginx
server {
  listen 80;
  server_name translator.songdailong.com;

  location / {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

Then enable TLS with Certbot or your certificate manager.

Important:

- Keep this server block separate from WordPress virtual hosts.
- Do not share the same upstream as WordPress.
- Route only `translator.songdailong.com` to this app.

## 8. WordPress Isolation

Since the VPS already runs multiple WordPress sites, keep translator isolated by:

- Separate `server_name`
- Separate service/process
- Separate port
- Separate logs
- Separate `.env`
- Separate restart policy
- Separate deployment directory

Recommended checks:

1. Make sure Nginx does not map the translator domain to a WordPress root.
2. Make sure PHP-FPM pools are not reused by the translator app.
3. Make sure the translator app cannot write into WordPress folders.
4. Make sure firewall rules only expose `80/443` publicly.

## 9. Internal Access Control

The app already supports internal login via:

- `APP_AUTH_USERNAME`
- `APP_AUTH_PASSWORD`
- `APP_AUTH_SECRET`

Use this together with Nginx/TLS so the service is public on the internet but
usable only by authenticated internal users.

## 10. Health and Monitoring

Use the health endpoint:

- `GET /healthz`

Monitor:

- HTTP 200 response
- Nginx upstream availability
- container or systemd restart count
- disk usage
- log growth

## 11. Update Flow

Each update should follow this order:

1. Pull latest GitHub changes.
2. Rebuild the Docker image or restart the Node service.
3. Verify `GET /healthz`.
4. Open `translator.songdailong.com`.
5. Test one full capture session.
