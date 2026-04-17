---
name: add-google-tasks
description: Add Google Tasks integration to NanoClaw. Lets the agent create, list, update, and delete tasks in Google Tasks. Tool-only — no polling or channel mode.
---

# Add Google Tasks Integration

This skill adds Google Tasks tools to NanoClaw. The agent can create, list, update, complete, and delete tasks. Tool-only mode — no inbox polling or channel registration.

## Phase 1: Pre-flight

### Check if already applied

Check if `mcp__google_tasks__*` already exists in `container/agent-runner/src/index.ts`. If it does, skip to Phase 3 (GCP Setup). The code changes are already in place.

## Phase 2: Code Changes

### Merge the feature branch

```bash
git fetch origin feature/google-tasks
git merge origin/feature/google-tasks
```

This merges in:
- `container/agent-runner/src/google-tasks-mcp-stdio.ts` (Google Tasks MCP server with 6 tools)
- `scripts/google-tasks-auth.ts` (OAuth authorization script)
- Google Tasks MCP server and `mcp__google_tasks__*` allowed tool in `container/agent-runner/src/index.ts`
- `~/.google-tasks-mcp` credentials mount in `src/container-runner.ts`

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: GCP Setup

### Check existing credentials

```bash
ls -la ~/.google-tasks-mcp/ 2>/dev/null || echo "No Google Tasks config found"
```

If `credentials.json` already exists, skip to Phase 4 (Build & Restart).

### GCP Project Setup

If the user already has a GCP project (e.g., from Gmail integration), they can reuse it. Otherwise create a new one.

Tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, search "Google Tasks API", click **Enable**
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - If prompted for consent screen: choose "External", fill in app name and email, save
>    - Application type: **Desktop app**, name: anything (e.g., "NanoClaw Tasks")
> 4. Click **DOWNLOAD JSON** and save as `gcp-oauth.keys.json`
>
> Where did you save the file? (Give me the full path, or paste the file contents here)

If user provides a path, copy it:

```bash
mkdir -p ~/.google-tasks-mcp
cp "/path/user/provided/gcp-oauth.keys.json" ~/.google-tasks-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.google-tasks-mcp/gcp-oauth.keys.json`.

### OAuth Authorization

Run the authorization script:

```bash
npx tsx scripts/google-tasks-auth.ts
```

The script will print an authorization URL. Tell the user to open it in their browser, sign in, grant access, and paste the authorization code back. If they see an "app isn't verified" warning, click "Advanced" then "Go to [app name] (unsafe)" — this is normal for personal OAuth apps.

Verify credentials were created:

```bash
ls ~/.google-tasks-mcp/credentials.json
```

## Phase 4: Build & Restart

Clear stale per-group agent-runner copies (they only get re-created if missing, so existing copies won't pick up the new MCP server):

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

Rebuild the container (agent-runner changed):

```bash
cd container && ./build.sh
```

Then compile and restart:

```bash
npm run build
systemctl --user restart nanoclaw          # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Tell the user:

> Google Tasks is connected! Try sending one of these in your main channel:
>
> - `@Andy list my task lists`
> - `@Andy create a task called "Test" in my default list`

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### OAuth token expired or invalid

Re-authorize:

```bash
rm ~/.google-tasks-mcp/credentials.json
npx tsx scripts/google-tasks-auth.ts
```

Then clear stale copies, rebuild, and restart (see Phase 4).

### Container can't access Google Tasks

- Verify `~/.google-tasks-mcp` is mounted: check `src/container-runner.ts` for the `.google-tasks-mcp` mount
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

## Removal

1. Remove the `~/.google-tasks-mcp` mount block from `src/container-runner.ts`
2. Remove `google_tasks` MCP server entry and `'mcp__google_tasks__*'` from `container/agent-runner/src/index.ts`
3. Delete `container/agent-runner/src/google-tasks-mcp-stdio.ts`
4. Delete `scripts/google-tasks-auth.ts`
5. Delete `.claude/skills/add-google-tasks/`
6. Clear stale copies, rebuild, restart:
   ```bash
   rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
   cd container && ./build.sh && cd ..
   npm run build
   systemctl --user restart nanoclaw          # Linux
   # macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
