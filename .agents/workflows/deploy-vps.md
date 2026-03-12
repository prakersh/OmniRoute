---
description: Deploy the latest OmniRoute code to the Akamai VPS (69.164.221.35) via npm
---

# Deploy to VPS Workflow

Deploy OmniRoute to the production VPS using `npm install -g` + PM2.

**VPS:** `69.164.221.35` (Akamai, Ubuntu 24.04, 1GB RAM + 2.5GB swap)
**Local VPS:** `192.168.0.15` (same setup)
**Process manager:** PM2 (`omniroute`)
**Port:** `20128`

> [!IMPORTANT]
> PM2 runs from the global npm package at `/usr/lib/node_modules/omniroute`.
> **DO NOT** use git clone or local copies. The `npm install -g` command handles
> building, publishing, and installing the standalone app in one step.

## Steps

### 1. Publish to npm

Ensure the version in `package.json` is bumped and the package is published:

```bash
npm publish
```

### 2. Install on VPS and restart PM2

// turbo-all

```bash
ssh root@69.164.221.35 "npm install -g omniroute@latest && pm2 restart omniroute && pm2 save && echo '✅ Deploy complete!'"
```

For the local VPS:

```bash
ssh root@192.168.0.15 "npm install -g omniroute@latest && pm2 restart omniroute && pm2 save && echo '✅ Deploy complete!'"
```

### 3. Verify the deployment

```bash
ssh root@69.164.221.35 "pm2 list && cat \$(npm root -g)/omniroute/package.json | grep version | head -1 && curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:20128/"
```

Expected: PM2 shows `online`, version matches published, HTTP returns `307` (redirect to login).

## How it works

1. `npm publish` builds Next.js standalone + bundles everything into the npm package
2. `npm install -g omniroute@latest` downloads and installs to `/usr/lib/node_modules/omniroute/`
3. PM2 is registered to run `npm start` from that directory (cwd: `/usr/lib/node_modules/omniroute`)
4. `pm2 restart omniroute` picks up the new code immediately

## PM2 Setup (one-time)

If PM2 needs to be reconfigured from scratch:

```bash
ssh root@<VPS> "
  cd /usr/lib/node_modules/omniroute &&
  PORT=20128 pm2 start app/server.js --name omniroute --env PORT=20128 &&
  pm2 save &&
  pm2 startup
"
```

## Notes

- The `.env` file is at `/usr/lib/node_modules/omniroute/.env`. Back it up before major npm updates.
- PM2 is configured with `pm2 startup` to auto-restart on reboot.
- Nginx proxies `omniroute.online` → `localhost:20128`.
- The VPS has only 1GB RAM — builds happen locally via `npm publish`, not on the VPS.
