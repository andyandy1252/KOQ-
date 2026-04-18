# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Express webhook server (`index.js`). Flow: **Formspree** form submission → normalize fields → **OpenAI** drafts an SMS reply → **Twilio** sends it to the lead's phone, including a **Calendly** booking link.

## Commands

```bash
npm install        # first time
npm start          # production
npm run dev        # watch mode (Node --watch)
```

No test runner is configured. Use `DRY_RUN=1` to exercise the full code path without sending real SMS.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Yes | GPT-4o-mini for SMS generation |
| `TWILIO_ACCOUNT_SID` | Yes (live) | Skipped in DRY_RUN |
| `TWILIO_AUTH_TOKEN` | Yes (live) | Skipped in DRY_RUN |
| `TWILIO_FROM_NUMBER` | Yes (live) | E.164 format |
| `CALENDLY_URL` | No | Overrides `calendly_url` in business.json |
| `WEBHOOK_SECRET` | No | If set, requires `Authorization: Bearer <secret>` |
| `DRY_RUN` | No | `1` or `true` → logs only, no Twilio send |
| `PORT` | No | Default 3000 |

## Architecture

Everything lives in `index.js` (~240 lines). Key functions:

- `loadBusiness()` — reads `business.json` at startup and on each request; cached in `businessCache`
- `extractFields(body)` — flattens Formspree's nested JSON, strips `_`-prefixed meta fields
- `pickPhone(fields)` — tries common phone field names, falls back to regex scan of all keys
- `normalizePhone(raw)` — coerces to E.164 (`+1XXXXXXXXXX`)
- `generateSms({ fields, business })` — calls OpenAI with a system prompt built from `business.json`; expects JSON response with `{ sms_body, out_of_area, needs_human }`
- `appendLeadLog(entry)` — appends JSONL to `logs/leads.jsonl`

The OpenAI call uses `response_format: { type: "json_object" }` to guarantee structured output. SMS body is capped at 1600 chars client-side after the API call.

## business.json

Controls the AI's behavior without code changes: service areas, pricing rules, Calendly URL, SMS footer, and tone. Edit this file to customize for a specific client. The `pricing_rules` field is injected verbatim into the system prompt.

## Deployment

Expose `/webhook/formspree` publicly over HTTPS. In Formspree dashboard, set the webhook URL to that endpoint. The `/health` endpoint returns `{ ok: true, dry_run: ... }` for uptime checks.
