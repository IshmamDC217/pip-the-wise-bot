# OpenClaw Gateway Setup

Pip uses [OpenClaw](https://docs.openclaw.ai) as a local gateway to proxy AI requests to Anthropic. Instead of calling the Anthropic API directly, the bot sends requests to OpenClaw's OpenAI-compatible HTTP endpoint running on localhost.

## Prerequisites

- Node.js 22+
- OpenClaw installed globally: `npm install -g openclaw@latest`

## What needs to be running

**The OpenClaw gateway must be running before starting the bot.**

```bash
# Check status
openclaw gateway status

# Start (runs as a background service)
openclaw gateway start

# Restart (after config changes)
openclaw gateway restart

# Stop
openclaw gateway stop
```

The gateway runs on `http://127.0.0.1:18789` by default and starts automatically on login (installed as a Windows Startup item).

## Configuration

Config file: `~/.openclaw/openclaw.json`

Key settings already configured:

| Setting | Value | Purpose |
|---|---|---|
| `env.ANTHROPIC_API_KEY` | `sk-ant-...` | Your Anthropic key (stored in OpenClaw, not the app) |
| `agents.defaults.model.primary` | `anthropic/claude-sonnet-4-6` | Default model |
| `gateway.mode` | `local` | Local-only gateway |
| `gateway.auth.mode` | `none` | No auth needed (loopback only) |
| `gateway.http.endpoints.chatCompletions.enabled` | `true` | Enables the `/v1/chat/completions` endpoint |

To update settings:

```bash
openclaw config set <key> <value>
openclaw gateway restart
```

## How the bot uses it

`ai.service.ts` sends requests to:

```
POST http://127.0.0.1:18789/v1/chat/completions
```

Using the standard OpenAI chat completions format. OpenClaw translates this to the Anthropic API under the hood.

The bot reads `OPENCLAW_GATEWAY_URL` from env (falls back to `http://127.0.0.1:18789`).

## Environment variables

The `.env` file no longer needs `ANTHROPIC_API_KEY` for the bot itself — OpenClaw manages the key. You can keep it in `.env` for other tools that might need it.

| Variable | Required | Default |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | No | `http://127.0.0.1:18789` |

## Troubleshooting

```bash
# Full status + diagnostics
openclaw status

# View logs
openclaw gateway status   # shows log file path

# Test the endpoint manually
curl http://127.0.0.1:18789/health
curl http://127.0.0.1:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'

# Dashboard (browser)
http://127.0.0.1:18789/
```

Common issues:

- **Gateway not starting**: Make sure `gateway.mode` is set to `local`
- **404 on `/v1/chat/completions`**: Enable the endpoint with `openclaw config set gateway.http.endpoints.chatCompletions.enabled true` then restart
- **Bot can't connect**: Check the gateway is running with `openclaw gateway status`
