---
name: message-history
description: Search and read the user's own Signal and WhatsApp message history across every chat they participate in (DMs and groups) — even conversations the agent is not a registered participant in. Use when the user asks what someone said, to find a message, to list recent chats, or to recall context from any of their own conversations. Messages are captured forward-only from the moment observer devices were linked.
allowed-tools: Bash(node:*)
---

# message-history — query observed Signal & WhatsApp chats

## Availability

This skill only works in the main channel — the store mount and skill files are not present in other groups' containers. If `node ~/.claude/skills/message-history/search.js list` fails with "Database not found", observer daemons have not been linked yet; ask the user to run `npm run link-signal-observer` on the host.

## Invocation

```bash
node ~/.claude/skills/message-history/search.js <subcommand> [flags]
```

## Subcommands

### `search` — full-content LIKE match across all chats

```bash
node ~/.claude/skills/message-history/search.js search --query "dentist"
node ~/.claude/skills/message-history/search.js search --query "deploy" --channel signal --since 2026-04-01
node ~/.claude/skills/message-history/search.js search --query "rsvp" --chat "+15551234567"
```

Flags: `--query <text>` (required), `--chat <jid>`, `--channel signal|whatsapp`, `--since ISO`, `--until ISO`, `--limit N` (default 50, max 200).

### `show` — chronological page of one chat

```bash
node ~/.claude/skills/message-history/search.js show --chat "+15551234567"
node ~/.claude/skills/message-history/search.js show --chat "group-jid@g.us" --after 2026-04-15 --limit 200
```

Flags: `--chat <jid>` (required), `--before ISO`, `--after ISO`, `--limit N` (default 100, max 500).

### `list` — directory of observed chats with previews

```bash
node ~/.claude/skills/message-history/search.js list
node ~/.claude/skills/message-history/search.js list --channel whatsapp --groups-only
node ~/.claude/skills/message-history/search.js list --dms-only --limit 20
```

Flags: `--channel signal|whatsapp`, `--groups-only` or `--dms-only`, `--limit N` (default 50, max 500).

## Output shape

Each row is one line, readable as-is — no parsing required. Format:

```
<timestamp>  (<channel>/<dm|group>) [optional chat name]  <who>: <content preview>
```

`<who>` is `"me"` when the user themself sent the message (captured via the user-linked observer device), otherwise the sender's name or number.

## When to use

- User asks "what did X say about Y?" or "find the message about Z"
- User asks to recall recent activity in a chat they haven't opened
- User asks which DMs or groups had activity today
- Agent needs context on a conversation it was not routed into

## When NOT to use

- Messages the agent was directly routed — those are already in this turn's context.
- Non-main groups — the skill is not mounted there.
- Historical data from before observers were linked — capture is forward-only.

## Examples

```bash
# What did Mom say yesterday?
node ~/.claude/skills/message-history/search.js list --dms-only --limit 10
node ~/.claude/skills/message-history/search.js show --chat "+1MOMS_NUMBER" --after 2026-04-21

# Find everywhere the word "invoice" appeared on Signal this month
node ~/.claude/skills/message-history/search.js search --query invoice --channel signal --since 2026-04-01

# Scan recent group chatter
node ~/.claude/skills/message-history/search.js list --groups-only
```
