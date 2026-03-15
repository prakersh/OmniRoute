# OmniRoute Agent Notes

This file is the quick operational context for agents working in this repo.

## Source of Truth

- Active git repo: `/tmp/omniroute-src`
- Local compose stack path: `docker-compose.yml`
- Default remote deploy target: `root@100.100.1.5:/root/omni-remote`

## Deployment Workflow

- Preferred command for parity deploy (local + remote):
  - `bash scripts/deploy-dual.sh`
- `scripts/deploy-dual.sh` will:
  - build `omniroute:base` locally
  - recreate local `omniroute` container
  - rsync repo to remote (excluding `.git`, `node_modules`, `.next`, `.env`, `/data/`, `/logs/`)
  - build and recreate remote `omniroute` container

## Recent Critical Fix

- Added server-side preflight context compression in:
  - `open-sse/handlers/chatCore.ts`
- Behavior:
  - runs `compressContext(body, { provider, model: resolvedModel })` before translation/execution
  - reduces oversized history before provider calls/fallback paths
  - intended to prevent context-window failures in fallback/provider translation paths

## Verification Checklist

- Container health:
  - `docker ps --filter name=omniroute --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"`
- Local API reachability:
  - `curl -sS http://localhost:20128/v1/models | head`
- Remote API reachability:
  - `curl -sS http://100.100.1.5:20128/v1/models | head`
- If provider calls fail with 401/403, treat as credential/account issue, not deployment failure.

## Notes

- Keep local and remote runtime in sync after gateway fixes.
- Prefer committing gateway logic changes together with deployment-script updates when both are touched.
