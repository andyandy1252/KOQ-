# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Express webhook server (`server/index.js`). Flow: **Formspree** form submission → normalize fields → **OpenAI** drafts a reply → **Nodemailer** (Gmail) sends an email alert to the owner with all lead details and the AI-drafted copy-paste response.

Twilio was removed. The auto-response to leads is handled by **ManyChat** connected to Meta Lead Ads — the webhook server handles website form leads only.

## Commands

```bash
# Run from the server/ directory
npm install        # first time
npm start          # production
npm run dev        # watch mode (Node --watch)
```

No test runner is configured. Use `DRY_RUN=1` to exercise the full code path without sending real email.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Yes | GPT-4o-mini for reply generation |
| `EMAIL_FROM` | Yes (live) | Gmail address to send from |
| `EMAIL_PASS` | Yes (live) | Gmail App Password (not login password) — generate at myaccount.google.com → Security → App passwords |
| `EMAIL_TO` | No | Where lead alerts go; defaults to `EMAIL_FROM` |
| `CALENDLY_URL` | No | Overrides `calendly_url` in business.json |
| `WEBHOOK_SECRET` | No | If set, requires `Authorization: Bearer <secret>` |
| `DRY_RUN` | No | `1` or `true` → logs only, no email sent |
| `PORT` | No | Default 3000 |

## Architecture

Everything lives in `server/index.js`. Key functions:

- `loadBusiness()` — reads `business.json` at startup and on each request; cached in `businessCache`
- `extractFields(body)` — flattens Formspree's nested JSON, strips `_`-prefixed meta fields
- `pickPhone(fields)` — tries common phone field names, falls back to regex scan of all keys
- `normalizePhone(raw)` — coerces to E.164 (`+1XXXXXXXXXX`)
- `generateReply({ fields, business })` — calls OpenAI with a system prompt built from `business.json`; expects JSON response with `{ message_body, out_of_area, needs_human }`
- `buildLeadEmail({ fields, phone, message_body, meta })` — formats the owner notification email with lead details + AI-drafted copy-paste response
- `appendLeadLog(entry)` — appends JSONL to `logs/leads.jsonl`

The OpenAI call uses `response_format: { type: "json_object" }` to guarantee structured output. Message body is capped at 1600 chars.

## business.json

Controls the AI's behavior without code changes: service areas, pricing rules, Calendly URL, and tone. Edit this file to customize. The `pricing_rules` field is injected verbatim into the system prompt.

## Deployment

Expose `/webhook/formspree` publicly over HTTPS. In Formspree dashboard, set the webhook URL to that endpoint. The `/health` endpoint returns `{ ok: true, dry_run: ... }` for uptime checks.
