const crypto = require("crypto");

const META_DATASET_ID = process.env.META_DATASET_ID || "";
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN || "";

function sha256(val) {
  if (val == null || String(val).trim() === "") return null;
  return crypto.createHash("sha256").update(String(val).trim().toLowerCase()).digest("hex");
}

function hashPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const e164 =
    digits.length === 10 ? `+1${digits}` :
    digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  return e164 ? sha256(e164) : null;
}

function stageToMetaEvent(stageName) {
  if (!stageName) return null;
  const s = stageName.toLowerCase();
  if (s.includes("new lead") || s.includes("call now")) return "Lead";
  if (s.includes("booked")) return "Schedule";
  if (s.includes("completed") || s.includes("complete")) return "CompleteRegistration";
  if (s.includes("lost") || s.includes("resting")) return null;
  if (s.includes("day") || s.includes("call") || s.includes("warm") ||
      s.includes("contact") || s.includes("in contact")) return "Contact";
  return "Lead";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const contact = body.contact || (body.opportunity && body.opportunity.contact) || {};
  const stageName =
    body.pipeline_stage || body.pipelineStage || body.stage ||
    (body.opportunity && body.opportunity.pipelineStage && body.opportunity.pipelineStage.name) ||
    (body.opportunity && body.opportunity.stage) || "";
  const eventType = (body.type || body.event || "").toLowerCase();
  const leadId = body.lead_id || body.leadId || contact.lead_id || contact.leadId || null;

  let metaEvent;
  if (stageName) {
    metaEvent = stageToMetaEvent(stageName);
  } else if (eventType.includes("contact") || eventType.includes("lead")) {
    metaEvent = "Lead";
  } else {
    metaEvent = "Lead";
  }

  if (!metaEvent) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, stage: stageName }) };
  }

  const userData = {};
  const em = sha256(contact.email);
  if (em) userData.em = [em];
  const ph = hashPhone(contact.phone);
  if (ph) userData.ph = [ph];
  const fn = sha256(contact.firstName || contact.first_name);
  if (fn) userData.fn = [fn];
  const ln = sha256(contact.lastName || contact.last_name);
  if (ln) userData.ln = [ln];
  const city = (contact.city || "").replace(/\s+/g, "");
  const ct = sha256(city);
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
      event_name: metaEvent,
      event_time: Math.floor(Date.now() / 1000),
      custom_data: {
        event_source: "crm",
        lead_event_source: "GoHighLevel",
      },
      user_data: userData,
    }],
  };

  const url = `https://graph.facebook.com/v26.0/${META_DATASET_ID}/events?access_token=${META_CAPI_TOKEN}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Meta CAPI ${res.status}: ${JSON.stringify(data)}`);
    console.log(`[META CAPI] Sent "${metaEvent}" — events_received: ${data.events_received}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, meta_event: metaEvent, events_received: data.events_received }),
    };
  } catch (e) {
    console.error("[META CAPI] Error:", e.message);
    return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
  }
};
