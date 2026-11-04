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
service `claude-me-relay`), not from scratch. It is for **Nabil's group only**; the
big iklipse bot for the team and clients is not touched. The group speaks English
by default, and Nabil can change the language in the settings.

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
| **Grok** (xAI) | worker | Grok subscription (SuperGrok / X Premium+) through xAI's own `grok` CLI (Grok Build): `grok login`, then headless `grok -p … --output-format streaming-json`, sessions with `-s`/`-r`. To check on install: that `grok login` works on a server with no browser. If it doesn't, xAI's documented headless sign-in through OpenCode ("xAI Grok OAuth (Headless / Remote / VPS)"), still the subscription. No API key |
| **Jev** (Typesafe AI) | **router and judge**, never a writer (see below) | Typesafe API key, early access. Fallback when there is no access: Claude Haiku asked the same questions |

### Why Jev only routes
Jev is built to never write text: it only answers questions whose possible answers are set in advance (pick one of up to 255 choices, a score, or yes/no), each with a probability, in 70–500 ms, for $0.042 per million input tokens (output free). So it can't answer Nabil or write code. It can make every quick decision in the system:
- **Route:** which agent, model and effort for a task (the main job).
- **Guard:** is this step sensitive (deploy, delete, send outside, pay)? If yes, it waits for Nabil's yes.
- **Judge:** in team compare, score each worker's answer so the Central Agent starts from the best one.
- **Done or not:** did the worker actually finish what was asked, or should it go again?
- **Triage:** is a message a new task, a follow-up to a chat, or a command?

Rules taken from the brief and from the videos:
- No cookies, no browser tricks, no unofficial tokens. If a provider needs an API key or a paid plan for server use, we say so and use that.
- Keys and logins stay out of the logs, out of WhatsApp, and out of other agents' environments. Each CLI runs with only its own login; API keys are read by the relay from root-only files (systemd `LoadCredential`), the same way `waha.key` is today.

## The tasks this plan must pass

Every phase below exists for one of these. Each one is tested before it is called done.

| # | Task | Phase |
|---|---|---|
| T1 | GPT, Claude, Grok and Jev each connected to the same bot identity/number via authorized interfaces | 1 |
| T2 | Model switching available any time from WhatsApp, Slack and the dashboard | 2, 7, 8 |
| T3 | Default model selectable globally or by workflow, user or task type | 3 |
| T4 | Approved history, instructions and task state persist across model switches | 2 |
| T5 | Nabil can edit system instructions, language, tone, autonomy, guardrails, workflows and memory without coding | 5, 8 |
| T6 | Bot uses authorized tools to perform actions, not only generate text | 1 |
| T7 | Model/API faults, active model and usage costs visible, with spend controls | 6, 8 |

## What gets built, in order

Each phase ends working and tested, and is installed only after you say go.

### Phase 1: one shape for every agent, all on the same number (T1, T6)
- Split `relay.mjs`: today `ask()` only knows Claude. Make `agents/` adapters with one shape:
  `run({ prompt, cwd, model, effort, session, plan }) → { text, session, usage, cost, model, error }`.
- `claude.mjs`: the code that runs today, moved, no change in behaviour.
- `codex.mjs`: `codex exec --json`, resume by session id, effort mapped to its reasoning setting.
- `grok.mjs`: `grok -p --output-format streaming-json`, sessions with `-s`/`-r`.
- `jev.mjs`: the decision calls (route, guard, judge, done, triage), with the Haiku fallback.
- All of them answer through the same WhatsApp number and group (the WAHA session the relay already uses).
- **Tools (T6):** each worker acts, not just talks. Claude keeps its tools and connectors; the same connectors (Drive, GitHub, …) are set up for codex and grok through their own MCP settings, signed in by Nabil. Each agent's allowed tools are listed in `agents.json`.
- An **agent** is kept apart from its model: `agents.json` holds name, role prompt, provider, model, effort, tools/permissions. Moving "Coding" from Claude to GPT is one change, the role stays.
- Every answer ends with one line: agent, provider, model, effort, time, and cost or usage.

### Phase 2: switch any time, nothing lost (T2 on WhatsApp, T4)
- `/use claude|gpt|grok`, `/model`, `/effort` work **in the middle of a chat**, any time. `/model` and `/effort` refuse values the provider doesn't have.
- **Handoff:** the relay keeps each chat's own record, not only the provider's session:
  - the history (what Nabil said, what each agent answered, which one answered);
  - the instructions in force (system, the chat's own, the agent's role);
  - the task state: the goal, what's approved, what's done, what's left, files touched.
- When the model changes, the new one starts with that record: the instructions and task state whole, the recent turns word for word, the older ones in a short summary. Its first line says it took over (e.g. "GPT took over from Claude").
- "Approved" items (a plan Nabil said go to, a decision he confirmed) are marked so no model drops them.
- Switching back to a provider resumes its own session when it still has one.
- Cost: a switch can't reuse the old model's cache, so it costs a little more. Nothing is lost.

### Phase 3: defaults and Automatic mode (T3)
- `settings.json` holds the defaults, used in this order, first match wins:
  1. what this chat chose (`/use`);
  2. the workflow's default (e.g. "website build" → Claude);
  3. the task type's default (code, research, writing, images, …; Jev decides the type);
  4. the user's default (Nabil only for now; kept so more people can be added later);
  5. the global default.
- `/default`, `/default code gpt`, `/default workflow <name> claude` and so on set them from WhatsApp.
- `/auto`: Jev picks provider, model and effort from the logins that are signed in, the limits left (phase 6) and the task. `/dry <task>` shows the pick and why, spending nothing.
- If Jev is down: Haiku decides with the same rules; if that fails too, the global default.

### Phase 4: Team mode and the Central Agent
- `/team <task>`: the Central Agent (Claude Opus by default, changeable) decides:
  - **compare**: the same task to 2–3 workers at once, Jev scores the answers, the Central Agent merges;
  - **split**: it cuts the task into parts, gives each part to the best worker, then joins and checks the result.
- One progress message per worker, and `/stop` stops all of them.
- Parallel limit stays small (see "Server size").
- **Guardrails:** Jev checks every step; anything sensitive (deploy, merge, delete, sending outside the group, spending money) waits for Nabil's "yes".

### Phase 5: settings and memory without code (T5)
From WhatsApp, with plain commands (and later the same from the dashboard):
- `/instructions`: show or change the system instructions, for everything or one agent.
- `/language`: English by default; Nabil can set another.
- `/tone`: e.g. short and direct, friendly, formal.
- `/autonomy`: how much it does before asking: ask before every action / ask only for sensitive ones / do it and report.
- `/guardrails`: the list of what always needs his yes; add or remove.
- `/workflows`: named step lists (e.g. "new client site": research → plan → build → check), each with its default agent.
- `/memory`: show, add, change or forget what it remembers; one shared memory that every model reads, so a switch keeps it.
- Every change is saved with a time and can be undone (`/undo`).

### Phase 6: faults, active model, costs and spend controls (T7)
- **Faults:** when a model or API fails (logged out, limit hit, down, timeout), the group gets a short line saying which one and why, and Auto/Team moves to the next one. `/faults` lists the last ones.
- **Active model:** every answer's last line, and `/status`.
- **Costs:** `/usage` per provider per day/week/month: dollars where the provider reports them (Claude's CLI does, Jev's API does), otherwise tokens and how much of the plan's limit is used.
- **Spend controls:** a daily and weekly limit per provider, set by Nabil (`/limits`):
  - at 80%: a warning in the group;
  - at 100%: that provider is paused; Auto and Team skip it; a manual `/use` asks "over the limit, run anyway?";
  - Nabil can raise a limit, pause or resume a provider at any time.

### Phase 7: Slack (T2 on Slack)
- Same commands and the same chats from one Slack channel, owner only. A chat started on WhatsApp can go on in Slack and back. Needs a Slack app made by you (bot token + signing secret).

### Phase 8: Dashboard (T2, T5, T7) — planned, parked for now
Not built now. Planned so phases 1–7 already keep everything it will need.

- **Where:** a small web page on the same server, served by the relay behind Caddy (e.g. `dash.46-224-176-181.sslip.io`). It reads and writes the same `settings.json`, chats and usage the WhatsApp side uses, so both always agree.
- **Who:** Nabil only. Sign-in with a one-time code that the relay sends to his WhatsApp group: no password to keep.
- **Pages:**
  - **Models:** each provider signed in or not, the active model per chat, switch it, set the defaults (global, workflow, task type, user).
  - **Chats:** every chat, its model, its task state and history; stop a run.
  - **Settings:** instructions, language, tone, autonomy, guardrails, workflows.
  - **Memory:** read, edit, forget.
  - **Usage & faults:** costs per provider and period, the fault list, the spend limits.
- **Built after** phases 1–7 work, on your go.

## Not in this plan
- Abliterated models, App use, Default, the empty box: later branches of the flowchart.
- The big iklipse bot (team and clients): not touched.
- LangGraph / LiteLLM: not needed. LiteLLM doesn't use CLI logins, and the relay already does the queueing.

## Server size
Each agent working takes about 300–600 MB of memory while it runs. The server has 3.7 GB; WAHA, the brain and the rest use about 1 GB, and a voice note being written out takes about 1 GB more for a moment. So two agents at once is safe; more requests wait their turn. Team mode with three or four workers at once could fill the memory, and then Linux kills programs, possibly WAHA, which takes WhatsApp down until it restarts. The next size up (CX33, 8 GB) removes that. Resizing is a server change, so it is your call.

## What I need from you before building
1. **GPT:** Nabil signs in to `codex` on the server (I start it, he opens the link and types the code).
2. **Grok:** Nabil's SuperGrok (or X Premium+) subscription, and he signs in to `grok` on the server the same way.
3. **Jev:** do you have early access? If yes, you set the Typesafe key on the server.
4. **Server:** resize to CX33 now, or keep 2 runs at once for now?
5. **Spend limits:** the starting daily/weekly limit for each provider (Nabil can change them any time).

## How it ships
- Branch `feat/normal-agents`, on top of `feat/personal-claude` (PR #71, not merged yet).
- One commit per phase; tests run before each commit.
- Install on the server only on your go, with the old `relay.mjs` kept as a backup for rollback.

## Status (2026-11-05)
- Server resized to CX33 (4 vCPU, 8 GB); disk kept at 40 GB so it can go back.
- codex 0.166 and grok 1.0.70 installed for `claude-me`. Not signed in yet.
- Jev key in place and checked: a real routing call answered in 312 ms (jev-1.14.0).
- Phases 1–7 built on `feat/normal-agents`: 25 unit tests and the end-to-end run against a fake WAHA and fake CLIs on the server (17/17) pass. Not installed on the live relay yet.
- Left for after the sign-ins: real GPT and Grok runs (Grok's event format is read loosely until then), their connectors (MCP), then installing on the live relay.
- Slack: code ready, waits for a Slack app. Dashboard: phase 8, parked.
- Guardrails are checked per request (Jev, else words); inside a run, each worker is told the guardrails and to ask first.
