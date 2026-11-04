# Plan: the "Normal agents" branch of the bot

From the board's flowchart:

```
BOT (interface: WhatsApp, Slack)
├── Nabil use
│   ├── Normal agents (Claude, GPT, Grok, Jev) ──► Central Agent
│   └── Abliterated models          (later, not in this plan)
└── App use ── Default / (empty)    (later, not in this plan)
```

This plan covers **Nabil use → Normal agents → Central Agent**. It is built on the
personal Claude group that already runs on the server (`personal/relay.mjs`,
service `claude-me-relay`), not from scratch. Everything the group shows stays in
English.

## Where we start (checked 2026-11-04)

| | |
|---|---|
| Server | iklipse-bot-nabil-claude, 46.224.176.181, 2 vCPU, 3.7 GB RAM, 14 GB disk free |
| Running | WAHA (docker), claude-me-relay, iklipse-brain, caddy |
| CLIs for user `claude-me` | `claude` only (Nabil's Max login). No codex, no grok, no jev |
| Relay today | One WhatsApp group, owner-only. Conversations (/new /chats /switch), folders (/cd), /model, /effort, /plan, /status, /stop, voice notes via local Whisper, 2 runs in parallel, state in `state.json` |

## The four models and what each is for

| Name | Role | How it signs in (official route only) |
|---|---|---|
| **Claude** (Anthropic) | worker + default Central Agent | `claude` CLI, Nabil's subscription. Already done |
| **GPT** (OpenAI) | worker | `codex` CLI, "Sign in with ChatGPT" (device code on a headless server), run with `codex exec --json` |
| **Grok** (xAI) | worker | To decide: xAI API key (api.x.ai), or the Cursor CLI if Nabil has Cursor and wants Grok through it. A Grok subscription login for servers is not assumed |
| **Jev** (Typesafe AI) | **router**: picks agent, model and effort. It decides, it does not write the answers | Typesafe API key, early access. Fallback when there is no access: Claude Haiku with the same questions |

Rules taken from the brief and from the videos:
- No cookies, no browser tricks, no unofficial tokens. If a provider needs an API key or a paid plan for server use, we say so and use that.
- Keys and logins stay out of the logs, out of WhatsApp, and out of other agents' environments. Each CLI runs with only its own login; API keys are read by the relay from root-only files (systemd `LoadCredential`), the same way `waha.key` is today.

## What gets built, in order

Each phase ends working and tested, and is installed only after you say go.

### Phase 1: one shape for every agent
- Split `relay.mjs`: today `ask()` only knows Claude. Make `agents/` adapters with one shape:
  `run({ prompt, cwd, model, effort, session, plan }) → { text, session, usage, cost, model }`.
- `claude.mjs`: the code that runs today, moved, no change in behaviour.
- `codex.mjs`: `codex exec --json`, resume by session id, effort mapped to its reasoning setting.
- `grok.mjs`: per the sign-in decision above.
- An **agent** is kept apart from its model: `agents.json` holds name, role prompt, provider, model, effort, tools/permissions. Moving "Coding" from Claude to GPT is one change, the role stays.
- Every answer ends with one line: which agent, provider, model, effort, time, and cost or usage when the provider gives it.
- Tests for each adapter's parsing (with saved sample outputs, no real calls).

### Phase 2: Manual mode
- `/use claude|gpt|grok` for the current chat; `/model` and `/effort` follow the chosen provider and refuse values it doesn't have.
- `/agents` lists the agents; `/agent <name>` picks one for the chat.
- The provider stays fixed for a whole chat (switching mid-chat loses the cache and costs more). `/use` in a running chat starts a new chat.

### Phase 3: Automatic mode (Jev)
- `/auto` (or a chat with no provider chosen): Jev gets the task and answers with choice / score / yes-no questions. It picks provider, model and effort from the logins that are actually signed in and from what is left of each one's usage.
- Sticky per chat. A new pick only between phases (plan → build).
- `/dry <task>` shows what it would pick and why, and spends nothing.
- If Jev is down or not available: Haiku decides with the same rules; if that fails too, Claude.

### Phase 4: Team mode and the Central Agent
- `/team <task>`: the Central Agent (Claude Opus by default, changeable) decides:
  - **compare**: the same task to 2–3 workers at once, then it compares and merges;
  - **split**: it cuts the task into parts, gives each part to the best worker, then joins and checks the result.
- One progress message per worker ("GPT: working 2 min · Edit: index.ts"), and `/stop` stops all of them.
- Parallel limit stays small (see "Server size").
- Anything sensitive (deploy, merge, delete, sending to people outside the group, spending money) waits for Nabil's "yes" in the group before it runs.

### Phase 5: money and limits
- Usage per provider per day and week kept in `state.json` (no Postgres/Redis needed for one user on this server).
- A weekly cap per provider; at 80% a warning, at 100% that provider is skipped by auto/team.
- `/usage` shows the week so far.

### Phase 6: Slack (the flowchart's second interface)
- Same commands from one Slack channel, owner only. Needs a Slack app made by you (bot token + signing secret). Starts only after phases 1–5 work on WhatsApp.

## Not in this plan
- Abliterated models, App use, Default, the empty box: later branches of the flowchart.
- A web dashboard: comes with "App use".
- LangGraph / LiteLLM: not needed. LiteLLM doesn't use CLI logins, and the relay already does the queueing.

## Server size
Each CLI run takes about 300–600 MB. With WAHA, the brain and Whisper on 3.7 GB, two runs at once is the safe limit now. Team mode with three workers needs the next size up (CX33, 8 GB). Resizing is a server change, so it is your call.

## What I need from you before building
1. **GPT:** Nabil signs in to `codex` on the server (I start it, he opens the link and types the code).
2. **Grok:** xAI API key, or Cursor CLI? Whichever it is, the key or login is set by you, not by me.
3. **Jev:** do you have early access? If yes, you set the Typesafe key on the server.
4. **Server:** resize to CX33 now, or keep 2 runs at once for now?

## How it ships
- Branch `feat/normal-agents`, on top of `feat/personal-claude` (PR #71, not merged yet).
- One commit per phase; tests run before each commit.
- Install on the server only on your go, with the old `relay.mjs` kept as a backup for rollback.
