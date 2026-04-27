---
name: add-home-assistant
description: Add Home Assistant integration to NanoClaw. Lets the agent control devices, query entity state, and call services in HA via the official Model Context Protocol Server. Tool-only — no polling or channel mode.
---

# Add Home Assistant Integration

This skill adds Home Assistant tools to NanoClaw. The agent can list entities, query state, call services, and control devices via HA's official **Model Context Protocol Server** integration. Tool-only mode — no polling or channel registration.

The agent connects via `mcp-remote` (an stdio↔SSE bridge that npx-launches on demand), so no extra packages need to live in the container image. Auth is a Long-Lived Access Token bound to a single HA user — exposure is whatever entities that user can see in *Voice assistants → Expose*.

## Phase 1: Pre-flight

### Check if already applied

Check if `mcp__homeassistant__*` already exists in `container/agent-runner/src/index.ts`. If it does, skip to Phase 3 (HA Setup) — the code changes are already in place.

## Phase 2: Code Changes

### Merge the feature branch

```bash
git fetch origin feature/add-home-assistant
git merge origin/feature/add-home-assistant
```

This merges in:
- Conditional `homeassistant` MCP server in `container/agent-runner/src/index.ts` (only registered if `~/.homeassistant-mcp/url` and `token` files exist)
- `mcp__homeassistant__*` allowed tool in `container/agent-runner/src/index.ts`
- `~/.homeassistant-mcp` read-only mount in `src/container-runner.ts`

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: HA Setup

### Check existing credentials

```bash
ls -la ~/.homeassistant-mcp/ 2>/dev/null || echo "No HA config found"
```

If both `url` and `token` already exist, skip to Phase 4 (Build & Restart).

### Enable the MCP Server integration in HA

Tell the user:

> 1. In Home Assistant, go to **Settings → Devices & Services → + ADD INTEGRATION**.
> 2. Search "Model Context Protocol Server" and add it. (The default exposes entities through Assist — you control what's visible per-user under *Voice assistants → Expose*.)
> 3. Create or pick a dedicated HA user for NanoClaw (e.g. `nanoclaw-main`) under **Settings → People → Users**. Admin is fine if you want full control; or restrict by configuring exposed entities for that user.
> 4. Sign in as that user, open the user profile (avatar bottom-left → user name → Security tab), scroll to **Long-Lived Access Tokens**, and create one. Copy it — it's only shown once.

### Capture URL and token

Ask the user for:
- **HA URL** — base URL the container will reach. From the container, `localhost` resolves to itself, so use one of:
  - `http://host.docker.internal:8123` (HA on the same host as NanoClaw — works on Linux/macOS thanks to the existing `--add-host` wiring)
  - `http://192.168.x.x:8123` (LAN IP)
  - `https://your-instance.ui.nabu.casa` (Nabu Casa Cloud)
- **Long-Lived Access Token** from the previous step

Then write them to disk:

```bash
mkdir -p ~/.homeassistant-mcp
chmod 700 ~/.homeassistant-mcp
printf '%s' '<URL>'   > ~/.homeassistant-mcp/url
printf '%s' '<TOKEN>' > ~/.homeassistant-mcp/token
chmod 600 ~/.homeassistant-mcp/url ~/.homeassistant-mcp/token
```

(No trailing newline — the agent-runner trims, but cleaner files are easier to inspect.)

### Smoke-test reachability from the host

Before bringing the container into it, confirm the URL + token actually work:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $(cat ~/.homeassistant-mcp/token)" \
  "$(cat ~/.homeassistant-mcp/url)/api/"
```

Expected: `200`. Anything else → fix the URL or regenerate the token before continuing.

## Phase 4: Build & Restart

Clear stale per-group agent-runner copies (they only get re-created if missing, so existing copies won't pick up the new MCP server):

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

Rebuild the container (agent-runner changed):

```bash
cd container && ./build.sh && cd ..
```

Compile and restart:

```bash
npm run build
systemctl --user restart nanoclaw          # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Tell the user:

> Home Assistant is connected! Try sending one of these in your main channel:
>
> - `@Andy what entities can you see in Home Assistant?`
> - `@Andy turn off the living room lights`
> - `@Andy what's the temperature in the bedroom?`

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

The first invocation will spend a few seconds while `npx` fetches `mcp-remote`. Subsequent calls are fast (cached).

## Troubleshooting

### "Tool mcp__homeassistant__* not available"

- Confirm `~/.homeassistant-mcp/url` and `~/.homeassistant-mcp/token` both exist and are non-empty (the MCP server is only registered when both are present).
- Confirm the mount worked: `cat groups/main/logs/container-*.log | grep -i homeassistant | tail -20`.
- Stale per-group agent-runner copy? Re-run Phase 4 (clear `data/sessions/*/agent-runner-src`, rebuild container, restart).

### Container can't reach HA

- From inside a freshly-spawned container, `host.docker.internal` resolves to the host (Linux + macOS, via the existing `--add-host=host.docker.internal:host-gateway` flag in `src/container-runtime.ts`).
- LAN IPs work over default bridge networking; `localhost` / `127.0.0.1` will not (that's the container itself).
- mDNS names like `homeassistant.local` won't resolve from the container — use an IP or `host.docker.internal`.

### Auth errors from HA

- Long-Lived Access Tokens don't expire on their own but can be revoked. Regenerate under HA *user profile → Security*, then overwrite `~/.homeassistant-mcp/token`.
- Verify the user that owns the token has the **Model Context Protocol Server** integration enabled and entities exposed under *Settings → Voice assistants → Expose*.

### `mcp-remote` keeps re-downloading

It's just `npx -y` cache warmth — first call after a container rebuild is slow, then it's cached for the lifetime of the container.

## Removal

1. Delete `~/.homeassistant-mcp/` (keep the directory empty if you only want to disable temporarily — the MCP server unregisters when files are absent).
2. Remove the HA mount block from `src/container-runner.ts`.
3. Remove the `homeassistant` MCP server entry, the HA-config detection block, and `'mcp__homeassistant__*'` from `container/agent-runner/src/index.ts`.
4. Delete `.claude/skills/add-home-assistant/`.
5. Clear stale copies, rebuild, restart:
   ```bash
   rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
   cd container && ./build.sh && cd ..
   npm run build
   systemctl --user restart nanoclaw          # Linux
   # macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
