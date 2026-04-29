# Personal Voice Agent — Build Plan

> **Status**: Planning doc, drafted on phone. Will be moved to a new repo when starting implementation.
> **Goal**: Real-time voice AI agent with full MCP/tool access, reachable from a phone, ~$5–10/month.

---

## TL;DR Recommendation

Build on **[LiveKit Agents](https://github.com/livekit/agents)** as the realtime framework. Reach it from your phone via a **PWA** (push-to-talk or open-mic over WebRTC) initially; optionally add **Twilio SIP** later to dial in via your VIP number. Run STT/TTS **locally** (whisper.cpp + Piper) and use **Claude Haiku 4.5** as the brain with MCP tools. Async voice over Signal/WhatsApp stays as a fallback.

**Budget fits comfortably** at this scale (~$2–5/month at moderate use) because STT/TTS are local and Haiku is cheap.

---

## Reality Checks

| Idea | Verdict | Why |
|---|---|---|
| Live AI call over Signal | ❌ Not feasible | Signal voice is E2EE, no API. `signal-cli` is messaging only. |
| Live AI call over WhatsApp | ❌ Not feasible | Same — voice/video calls aren't exposed by WhatsApp Business or unofficial libs. |
| Async voice notes over Signal/WhatsApp | ✅ Already works | NanoClaw has `add-voice-transcription`. Whisper transcribes → agent → text reply (or TTS audio reply). |
| Real-time via WebRTC (PWA) | ✅ Best first target | Free transport, works on iOS/Android Safari/Chrome, no telephony fees. |
| Real-time via phone call | ✅ Works via SIP/Twilio | Use VIP number with Twilio (~$1.15/mo + $0.013/min) or self-hosted Asterisk if homelab can host. |

---

## Architecture Options (ranked)

### Option A — LiveKit Agents + PWA (recommended)
```
[Phone PWA] --WebRTC--> [LiveKit Cloud or self-hosted]
                              |
                       [LiveKit Agent worker]
                         |       |       |
                       STT     LLM      TTS
                    (whisper) (Claude) (Piper)
                              |
                          [MCP servers]
                       (calendar, email, web,
                        homelab SSH, docs)
```
- **Pros**: Mature framework, swappable providers, WebRTC is solved problem, PWA installs to home screen and feels like an app, works from anywhere with internet.
- **Cons**: Need to host the agent worker somewhere (homelab is fine), PWA UI is some work.
- **Cost**: LiveKit self-hosted = free. LiveKit Cloud free tier is generous (50 participant-mins/mo free, $0.005/min after). Likely free for personal use.

### Option B — Pipecat + PWA
- Similar to A. Pipecat (by Daily.co) is also strong, slightly more Python-flavored, very good docs, also supports telephony.
- Pick A or B based on which docs/examples click for you. I'd start with LiveKit.

### Option C — OpenAI Realtime API directly
- Speech-to-speech in one model, lowest latency. But: ~$0.06–0.30/min, **breaks the budget at any real usage**, and it's not Claude. Skip unless you change your mind on cost.

### Option D — Twilio Programmable Voice → LiveKit/Pipecat
- Stack on top of A or B once PWA works. Lets you literally call your agent from any phone.
- Twilio number $1.15/mo + $0.013/min inbound. ~$3–5/mo at light use. **Add as Phase 2.**

### Option E — Self-hosted SIP via your VIP number
- If your VIP provider supports SIP trunking, you can avoid Twilio. Asterisk/FreeSWITCH on the homelab. More work, more durable, no per-minute fees.
- **Add as Phase 3** once you know you want it.

---

## Component Choices

| Layer | Choice | Why | Cost |
|---|---|---|---|
| Realtime framework | LiveKit Agents | WebRTC + telephony + provider plugins | Free (self-host) |
| Phone client | PWA (React + LiveKit JS SDK) | No app store, installable, mic access works | Free |
| STT | whisper.cpp (local) | Already used by NanoClaw via `use-local-whisper` skill | Free |
| LLM | Claude Haiku 4.5 (default), Sonnet 4.6 (complex tool use) | Cheap, fast, great tool use | ~$1/M input, $5/M output |
| TTS | Piper (local, neural) | Fast, good quality, runs on CPU | Free |
| Tools | MCP servers (existing NanoClaw skills) | Reuse calendar, gmail, web, etc. | Existing |
| VAD / turn-taking | Silero VAD (built into LiveKit Agents) | Standard | Free |
| Hosting | Homelab (Docker container) | You already have it | Free |

**Fallback if local TTS sounds bad:** Cartesia Sonic (~$0.02/min) or ElevenLabs Flash. Budget impact: maybe $1–2/mo.

---

## Phase Plan

### Phase 0 — Spike (1 evening)
- Clone LiveKit Agents starter, run their voice-pipeline example with OpenAI/Anthropic.
- Talk to it from a laptop browser. Confirm latency feels OK (<700ms target).
- Decide: LiveKit vs Pipecat. Don't overthink — flip a coin if tied.

### Phase 1 — Local realtime stack (1–2 weekends)
- Set up self-hosted LiveKit server (Docker, single binary).
- Replace OpenAI Whisper with whisper.cpp (LiveKit has a plugin or wrap it).
- Replace ElevenLabs with Piper TTS.
- Wire Claude Haiku as the LLM via Anthropic SDK.
- Build minimal PWA: one button (start/stop), shows transcript, plays response audio.
- Test on phone: open PWA in Safari, "Add to Home Screen", talk to it.

### Phase 2 — MCP / tool access (1 weekend)
- Wire MCP client into the agent worker so it can use:
  - **Tasks**: Google Tasks (NanoClaw has `add-google-tasks` skill — port it) or Todoist
  - **Email**: Gmail (NanoClaw has `add-gmail`)
  - **Web search**: Brave Search MCP, or Tavily
  - **Documents**: Notion (already in tool list) or local markdown files
  - **Homelab admin**: SSH MCP server (e.g., `mcp-server-ssh`) restricted to specific commands; or build a small custom MCP that exposes `systemctl`, `docker ps`, `df`, etc. with allow-listed actions
- Reuse the NanoClaw approach where credentials are injected via OneCLI gateway, **not** baked into the container.

### Phase 3 — Telephony (optional, 1 weekend)
- Buy a Twilio number ($1.15/mo) OR configure SIP trunk on existing VIP number.
- Use LiveKit's SIP integration to bridge inbound calls to the agent.
- Test: dial number → talk to agent → hang up.

### Phase 4 — Polish
- Wake word? (Probably not — mic permission + button is fine for personal use.)
- Voice ID / authentication: simple shared-secret phrase, or just trust the PWA's auth.
- Memory: per-conversation summary written to a SQLite file (mirror NanoClaw's approach).
- Interruption handling (LiveKit handles this with VAD already).
- Background tasks: agent can return "I'll do that and text you" → fires off a background job → sends WhatsApp/Signal message when done.

---

## Repository Structure (target — for the new repo)

```
voice-agent/
├── README.md
├── docker-compose.yml          # livekit + agent worker + whisper + piper
├── agent/
│   ├── pyproject.toml          # or package.json if Node
│   ├── worker.py               # LiveKit agent entrypoint
│   ├── llm.py                  # Claude wrapper
│   ├── tools/                  # MCP client glue
│   │   ├── tasks.py
│   │   ├── email.py
│   │   ├── web.py
│   │   └── homelab.py
│   └── prompts/
│       └── system.md
├── pwa/                        # React + LiveKit JS
│   ├── index.html
│   ├── src/
│   │   ├── App.tsx
│   │   └── voice.ts
│   └── manifest.json           # for PWA install
├── stt/
│   └── whisper-server.dockerfile
├── tts/
│   └── piper-server.dockerfile
├── infra/
│   ├── livekit.yaml
│   └── caddy/                  # TLS reverse proxy (PWA needs HTTPS for mic)
└── docs/
    └── (this file, renamed)
```

---

## What to Reuse from NanoClaw

Even though this is a new repo, several NanoClaw pieces port directly:

- **MCP/skill loading patterns** — NanoClaw's container skills system is a clean way to manage tool access; copy the structure.
- **OneCLI credential gateway** — keeps API keys out of the container; reuse it.
- **Per-group memory pattern** (`groups/{name}/CLAUDE.md`) — adapt as per-conversation memory.
- **`add-voice-transcription` and `use-local-whisper`** — the whisper integration is already solved.
- **Channel skills** — Signal/WhatsApp can stay as async voice-note channels alongside the realtime PWA.

---

## Cost Model (estimated)

Assuming ~15 min/day of voice = ~7.5 hours/month.

| Item | Cost/mo |
|---|---|
| LiveKit (self-host on homelab) | $0 |
| Whisper STT (local) | $0 |
| Piper TTS (local) | $0 |
| Claude Haiku (heavy tool use, ~50k tokens/day) | ~$2–4 |
| Twilio number (Phase 3, optional) | $1.15 + ~$2 minutes |
| **Total Phase 1–2** | **~$2–4/mo** |
| **Total with telephony** | **~$5–7/mo** |

Comfortably under your $10 ceiling. If you swap to Cartesia TTS for nicer voice, add ~$2/mo.

---

## Open Questions / Decisions Needed

1. **Hosting**: homelab box always on? If yes, self-host everything. If not, a $5 Hetzner VPS works.
2. **PWA only, or PWA + native call?** I'd start PWA-only (Phase 1–2) and only add telephony if the PWA feels clunky.
3. **Voice**: any preference for the agent's voice? Piper has many; pick one early so it feels like "your" agent.
4. **Wake word**: do you want to be able to say "Hey [name]" hands-free, or is button-press fine? Hands-free adds Porcupine/openWakeWord (free, local) but more setup.
5. **Homelab admin scope**: which exact commands should the agent be able to run? Define a strict allow-list before Phase 2.
6. **Auth**: how do you keep someone else from talking to the agent if they get the URL? OAuth via Google? Magic link? Shared secret in the PWA?

---

## Next Concrete Steps (when you reach a computer)

1. Create new repo: `gh repo create personal-voice-agent --private`
2. Move this file to `docs/PLAN.md` in the new repo.
3. Spike: clone `https://github.com/livekit/agents` and run their `voice-pipeline-agent` example.
4. Decide between LiveKit and Pipecat after the spike.
5. Start Phase 1.

---

## References

- LiveKit Agents: https://github.com/livekit/agents
- LiveKit SIP / telephony: https://docs.livekit.io/sip/
- Pipecat: https://github.com/pipecat-ai/pipecat
- whisper.cpp: https://github.com/ggerganov/whisper.cpp
- Piper TTS: https://github.com/rhasspy/piper
- Silero VAD: https://github.com/snakers4/silero-vad
- Claude Agent SDK / MCP: https://docs.claude.com/en/docs/agents-and-tools/mcp
