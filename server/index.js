import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const CALENDLY_ENV = process.env.CALENDLY_URL || "";

const META_DATASET_ID = process.env.META_DATASET_ID || "";
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN || "";

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
  const keys = ["phone", "Phone", "tel", "mobile", "Mobile", "phone_number", "Phone number"];
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

async function generateReply({ fields, business }) {
  const calendly = getCalendlyUrl();
  const system = `You are a lead response assistant for a mobile detailing / ceramic coating business.

Business facts (JSON):
${JSON.stringify(business, null, 2)}

Calendly booking URL to include exactly once in the message: ${calendly || "(not set — ask them to reply and you will send a link)"}

Rules:
- Output MUST be valid JSON only, with keys: message_body (string), out_of_area (boolean), needs_human (boolean).
- message_body: under 900 characters, plain text, no markdown. Include the Calendly URL as a full https link if calendly is set.
- If the lead is clearly outside service_areas, set out_of_area true and politely decline or offer waitlist; still set needs_human if unsure.
- If you cannot safely respond (missing critical info), set needs_human true and ask one short question or ask them to call.
- Follow pricing_rules strictly; never invent prices not implied by business facts.
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
  const message_body = String(parsed.message_body || "").slice(0, 1600);
  return {
    message_body,
    out_of_area: Boolean(parsed.out_of_area),
    needs_human: Boolean(parsed.needs_human),
  };
}

function buildLeadEmail({ fields, phone, message_body, meta }) {
  const name = fields.name || fields.Name || fields.full_name || "Unknown";
  const vehicle = fields.vehicle || fields.Vehicle || fields.car || fields.year_make_model || "";
  const service = fields.service || fields.Service || fields.package || "";
  const calendly = getCalendlyUrl();

  const flags = [
    meta.out_of_area ? "OUT OF AREA" : null,
    meta.needs_human ? "NEEDS HUMAN REVIEW" : null,
  ].filter(Boolean);

  const subject = [
    flags.length ? `[${flags.join(" | ")}] ` : "",
    "New KOQ Lead",
    name !== "Unknown" ? ` — ${name}` : "",
    vehicle ? ` | ${vehicle}` : "",
  ].join("");

  const divider = "─".repeat(44);
  const text = [
    "NEW LEAD",
    flags.length ? flags.map((f) => `⚠️  ${f}`).join("\n") : null,
    divider,
    `Name:    ${name}`,
    `Phone:   ${phone}`,
    `Vehicle: ${vehicle || "—"}`,
    `Service: ${service || "—"}`,
    "",
    "All submitted fields:",
    ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`),
    divider,
    "AI-DRAFTED RESPONSE — copy and paste this to send:",
    divider,
    message_body,
    divider,
    calendly ? `Calendly link: ${calendly}` : "",
  ]
    .filter((l) => l !== null)
    .join("\n")
    .trim();

  return { subject, text };
}

function createTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASS,
    },
  });
}

// ── Meta Conversions API helpers ──────────────────────────────────────────────

function sha256(val) {
  if (val == null || String(val).trim() === "") return null;
  return crypto.createHash("sha256").update(String(val).trim().toLowerCase()).digest("hex");
}

function hashPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  return e164 ? sha256(e164) : null;
}

// Maps GHL pipeline stage names to Meta CAPI event names
function stageToMetaEvent(stageName) {
  if (!stageName) return null;
  const s = stageName.toLowerCase();
  if (s.includes("new lead") || s.includes("call now")) return "Lead";
  if (s.includes("booked")) return "Schedule";
  if (s.includes("completed") || s.includes("complete")) return "CompleteRegistration";
  if (s.includes("lost") || s.includes("resting")) return null;
  if (s.includes("day") || s.includes("call") || s.includes("warm") || s.includes("contact") || s.includes("in contact")) return "Contact";
  return "Lead";
}

async function sendMetaCAPIEvent({ eventName, contact, leadId }) {
  if (!META_DATASET_ID || !META_CAPI_TOKEN) {
    console.warn("[META CAPI] META_DATASET_ID or META_CAPI_TOKEN not set — skipping");
    return null;
  }

  const userData = {};
  const em = sha256(contact.email);
  if (em) userData.em = [em];
  const ph = hashPhone(contact.phone);
  if (ph) userData.ph = [ph];
  const fn = sha256(contact.firstName);
  if (fn) userData.fn = [fn];
  const ln = sha256(contact.lastName);
  if (ln) userData.ln = [ln];
  const ct = sha256((contact.city || "").replace(/\s+/g, ""));
  if (ct) userData.ct = [ct];
  const st = sha256(contact.state);
  if (st) userData.st = [st];
  const zp = contact.postalCode ? sha256(String(contact.postalCode).slice(0, 5)) : null;
  if (zp) userData.zp = [zp];
  const country = sha256(contact.country || "us");
  if (country) userData.country = [country];
  if (contact.id) userData.external_id = [sha256(contact.id)];
  if (leadId) userData.lead_id = Number(leadId);

  const payload = {
    data: [{
      action_source: "system_generated",
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      custom_data: {
        event_source: "crm",
        lead_event_source: "GoHighLevel",
      },
      user_data: userData,
    }],
  };

  const url = `https://graph.facebook.com/v26.0/${META_DATASET_ID}/events?access_token=${META_CAPI_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Meta CAPI ${res.status}: ${JSON.stringify(data)}`);
  console.log(`[META CAPI] Sent "${eventName}" — events_received: ${data.events_received}`);
  return data;
}

// ── App ───────────────────────────────────────────────────────────────────────

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

  const baseLog = { ts: new Date().toISOString(), fields, phone, dry_run: DRY_RUN };

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

  let message_body, meta;
  try {
    meta = await generateReply({ fields, business });
    message_body = meta.message_body;
  } catch (e) {
    appendLeadLog({ ...baseLog, error: "ai_failed", message: e.message });
    return res.status(500).json({ error: "AI generation failed", message: e.message });
  }

  if (DRY_RUN || !process.env.EMAIL_FROM || !process.env.EMAIL_PASS) {
    appendLeadLog({ ...baseLog, message_body, meta, email: "skipped" });
    console.log("[DRY_RUN] Lead from", phone);
    console.log("Draft response:\n", message_body);
    return res.json({ ok: true, dry_run: true, phone, message_body, meta });
  }

  const { subject, text } = buildLeadEmail({ fields, phone, message_body, meta });
  const to = process.env.EMAIL_TO || process.env.EMAIL_FROM;

  try {
    const transporter = createTransport();
    await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
    appendLeadLog({ ...baseLog, message_body, meta, email_to: to });
    return res.json({ ok: true, phone, email_sent: to, meta });
  } catch (e) {
    appendLeadLog({ ...baseLog, message_body, meta, error: "email_failed", message: e.message });
    return res.status(502).json({ error: "Email send failed", message: e.message });
  }
});

// GHL → Meta CAPI: fired by a GHL Workflow "Send Webhook" action on stage change
app.post("/webhook/ghl-event", async (req, res) => {
  const body = req.body;

  // GHL can nest contact under body.contact or body.opportunity.contact
  const contact = body.contact || body.opportunity?.contact || {};
  const stageName = body.pipeline_stage || body.pipelineStage || body.stage ||
    body.opportunity?.pipelineStage?.name || body.opportunity?.stage || "";
  const eventType = (body.type || body.event || "").toLowerCase();
  const leadId = body.lead_id || body.leadId || contact.lead_id || contact.leadId || null;

  // Determine which Meta event to fire
  let metaEvent;
  if (stageName) {
    metaEvent = stageToMetaEvent(stageName);
  } else if (eventType.includes("contact") || eventType.includes("lead")) {
    metaEvent = "Lead";
  } else {
    metaEvent = "Lead";
  }

  if (!metaEvent) {
    console.log(`[META CAPI] Skipped stage "${stageName}" — no mapped event`);
    return res.json({ ok: true, skipped: true, stage: stageName });
  }

  const contactData = {
    id: contact.id,
    email: contact.email,
    phone: contact.phone,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode || contact.postal_code || contact.zip,
    country: contact.country,
  };

  if (DRY_RUN) {
    console.log(`[DRY_RUN] META CAPI would send "${metaEvent}" for`, contactData.email || contactData.phone);
    return res.json({ ok: true, dry_run: true, meta_event: metaEvent, contact: contactData });
  }

  try {
    const result = await sendMetaCAPIEvent({ eventName: metaEvent, contact: contactData, leadId });
    return res.json({ ok: true, meta_event: metaEvent, events_received: result?.events_received });
  } catch (e) {
    console.error("[META CAPI] Error:", e.message);
    return res.status(502).json({ error: "Meta CAPI send failed", message: e.message });
  }
});

app.listen(PORT, () => {
  loadBusiness();
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`POST Formspree webhook → http://localhost:${PORT}/webhook/formspree`);
  if (DRY_RUN) console.log("DRY_RUN: Email sends disabled");
});
