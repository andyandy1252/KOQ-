import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import twilio from "twilio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const CALENDLY_ENV = process.env.CALENDLY_URL || "";

const LOG_DIR = path.join(__dirname, "logs");
const LEADS_LOG = path.join(LOG_DIR, "leads.jsonl");

let businessCache = null;
function loadBusiness() {
  const p = path.join(__dirname, "business.json");
  const raw = fs.readFileSync(p, "utf8");
  businessCache = JSON.parse(raw);
  return businessCache;
}

function getCalendlyUrl() {
  const b = businessCache || loadBusiness();
  return (CALENDLY_ENV || b.calendly_url || "").trim();
}

function normalizePhone(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

/** Formspree sends JSON with field names from your form; normalize to a flat object. */
function extractFields(body) {
  if (!body || typeof body !== "object") return {};
  const skip = new Set(["_subject", "_next", "_cc", "_format"]);
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (skip.has(k) || k.startsWith("_")) continue;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, extractFields(v));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function pickPhone(fields) {
  const keys = [
    "phone",
    "Phone",
    "tel",
    "mobile",
    "Mobile",
    "phone_number",
    "Phone number",
  ];
  for (const k of keys) {
    if (fields[k] != null && String(fields[k]).trim() !== "") {
      return normalizePhone(fields[k]);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (/phone|tel|mobile/i.test(k) && v != null && String(v).trim() !== "") {
      return normalizePhone(v);
    }
  }
  return null;
}

function appendLeadLog(entry) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LEADS_LOG, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.error("lead log failed", e.message);
  }
}

function checkWebhookAuth(req, res) {
  if (!WEBHOOK_SECRET) return true;
  const h = req.headers.authorization || "";
  const ok = h === `Bearer ${WEBHOOK_SECRET}`;
  if (!ok) res.status(401).json({ error: "Unauthorized" });
  return ok;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || undefined });

async function generateSms({ fields, business }) {
  const calendly = getCalendlyUrl();
  const system = `You are an SMS assistant for a mobile detailing / ceramic coating business.

Business facts (JSON):
${JSON.stringify(business, null, 2)}

Calendly booking URL to include exactly once in the message: ${calendly || "(not set — ask them to reply and you will send a link)"}

Rules:
- Output MUST be valid JSON only, with keys: sms_body (string), out_of_area (boolean), needs_human (boolean).
- sms_body: under 900 characters, plain text, no markdown. Include the Calendly URL as a full https link if calendly is set.
- If the lead is clearly outside service_areas, set out_of_area true and politely decline or offer waitlist; still set needs_human if unsure.
- If you cannot safely respond (missing critical info), set needs_human true and ask one short question or ask them to call.
- Follow pricing_rules strictly; never invent prices not implied by business facts.
- End with the sms_footer text from business facts on its own line if present.
- Tone: ${business.tone || "professional and brief"}`;

  const user = `New quote request. Form fields:\n${JSON.stringify(fields, null, 2)}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI returned non-JSON");
  }
  const sms_body = String(parsed.sms_body || "").slice(0, 1600);
  return {
    sms_body,
    out_of_area: Boolean(parsed.out_of_area),
    needs_human: Boolean(parsed.needs_human),
  };
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, dry_run: DRY_RUN });
});

app.post("/webhook/formspree", async (req, res) => {
  if (!checkWebhookAuth(req, res)) return;

  const business = loadBusiness();
  const fields = extractFields(req.body);
  const phone = pickPhone(fields);

  const baseLog = {
    ts: new Date().toISOString(),
    fields,
    phone,
    dry_run: DRY_RUN,
  };

  if (!phone) {
    appendLeadLog({ ...baseLog, error: "no_phone" });
    return res.status(400).json({
      error: "No phone number found in submission",
      hint: "Add a field named phone, tel, or mobile to your Formspree form",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    appendLeadLog({ ...baseLog, error: "missing_openai" });
    return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  }

  let sms_body;
  let meta;
  try {
    meta = await generateSms({ fields, business });
    sms_body = meta.sms_body;
  } catch (e) {
    appendLeadLog({ ...baseLog, error: "ai_failed", message: e.message });
    return res.status(500).json({ error: "AI generation failed", message: e.message });
  }

  if (DRY_RUN || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    appendLeadLog({
      ...baseLog,
      sms_body,
      meta,
      twilio: "skipped",
    });
    console.log("[DRY_RUN or missing Twilio] SMS would send to", phone, "\n", sms_body);
    return res.json({ ok: true, dry_run: true, phone, sms_body, meta });
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    appendLeadLog({ ...baseLog, error: "missing_twilio_from" });
    return res.status(500).json({ error: "TWILIO_FROM_NUMBER not set" });
  }

  try {
    const msg = await client.messages.create({
      from,
      to: phone,
      body: sms_body,
    });
    appendLeadLog({
      ...baseLog,
      sms_body,
      meta,
      twilio_sid: msg.sid,
    });
    return res.json({ ok: true, phone, message_sid: msg.sid, meta });
  } catch (e) {
    appendLeadLog({
      ...baseLog,
      sms_body,
      meta,
      error: "twilio_failed",
      message: e.message,
    });
    return res.status(502).json({ error: "Twilio send failed", message: e.message });
  }
});

app.listen(PORT, () => {
  loadBusiness();
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`POST Formspree webhook → http://localhost:${PORT}/webhook/formspree`);
  if (DRY_RUN) console.log("DRY_RUN: SMS sends disabled");
});
