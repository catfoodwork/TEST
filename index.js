const express = require("express");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());

const HUBSPOT_TOKEN = (process.env.HUBSPOT_TOKEN || "").replace(/\s+/g, "");
const MANUS_API_KEY = ((process.env.MANUS_API_KEY_1 || "") + (process.env.MANUS_API_KEY_2 || "")).replace(/\s+/g, "");
const PORT = process.env.PORT || 3000;

// Persist taskMap to file so it survives restarts
const TASK_MAP_FILE = "/tmp/taskmap.json";
function loadTaskMap() {
  try { if (fs.existsSync(TASK_MAP_FILE)) return JSON.parse(fs.readFileSync(TASK_MAP_FILE, "utf8")); } catch(e) {}
  return {};
}
function saveTaskMap(map) {
  try { fs.writeFileSync(TASK_MAP_FILE, JSON.stringify(map)); } catch(e) {}
}
const taskMap = loadTaskMap();

// ─────────────────────────────────────────────
// Poll Manus every 15s until task completes
// ─────────────────────────────────────────────
async function pollManusTask(taskId, companyId) {
  const MAX_ATTEMPTS = 80; // 80 x 15s = 20 mins max
  let attempts = 0;

  console.log(`⏳ Polling started for task ${taskId}`);

  const poll = async () => {
    if (attempts >= MAX_ATTEMPTS) {
      console.warn(`⏰ Polling timed out for task ${taskId}`);
      delete taskMap[taskId];
      saveTaskMap(taskMap);
      return;
    }

    attempts++;

    try {
      const res = await axios.get(
        `https://api.manus.im/v1/tasks/${taskId}`,
        {
          headers: {
            Authorization: `Bearer ${MANUS_API_KEY}`,
            "API_KEY": MANUS_API_KEY,
          },
        }
      );

      const task = res.data;
      const status = task?.status;
      console.log(`🔄 Poll ${attempts} — status: ${status}`);

      if (["stopped", "completed", "finish", "done"].includes(status)) {
        const message =
          task?.result?.message ||
          task?.message ||
          task?.output ||
          task?.result ||
          JSON.stringify(task);
        console.log(`📄 Manus result: ${JSON.stringify(message).substring(0, 200)}`);
        await processManusResult(taskId, companyId, typeof message === "string" ? message : JSON.stringify(message));
        return;
      }

      if (["failed", "error"].includes(status)) {
        console.error(`❌ Manus task ${taskId} failed`);
        delete taskMap[taskId];
        saveTaskMap(taskMap);
        return;
      }

      // Still running — keep polling
      setTimeout(poll, 15000);

    } catch (err) {
      console.error(`❌ Poll error:`, err.response?.data || err.message);
      setTimeout(poll, 15000);
    }
  };

  setTimeout(poll, 15000);
}

// ─────────────────────────────────────────────
// Parse Manus JSON and create HubSpot contact
// ─────────────────────────────────────────────
async function processManusResult(taskId, companyId, message) {
  let contact = null;
  try {
    // Manus returns array of message blocks — extract the last assistant text
    let text = message;
    if (typeof message === "string" && message.trim().startsWith("[")) {
      try {
        const blocks = JSON.parse(message);
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.role === "assistant" && Array.isArray(b.content)) {
            const tb = b.content.find(c => c.type === "output_text" || c.type === "text");
            if (tb) { text = tb.text; break; }
          }
          if (b.type === "output_text" || b.type === "text") { text = b.text || b.content; break; }
        }
      } catch(e2) { /* keep original */ }
    }
    console.log("🔍 Parsing text:", typeof text === "string" ? text.substring(0, 200) : JSON.stringify(text).substring(0, 200));
    const str = typeof text === "string" ? text : JSON.stringify(text);
    const cleaned = str.replace(/```json|```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) contact = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("❌ Failed to parse contact JSON:", e.message);
  }

  if (!contact || (!contact.first_name && !contact.last_name)) {
    console.warn("⚠️ No valid contact in Manus response");
    delete taskMap[taskId];
    saveTaskMap(taskMap);
    return;
  }

  console.log(`👤 Found: ${contact.first_name} ${contact.last_name} (${contact.job_title})`);

  const contactId = await createHubSpotContact(contact);
  if (contactId) {
    await associateContactWithCompany(contactId, companyId);
    console.log(`✅ Contact ${contactId} linked to company ${companyId}`);
  }

  delete taskMap[taskId];
  saveTaskMap(taskMap);
}

// ─────────────────────────────────────────────
// 1. HubSpot workflow triggers this
// ─────────────────────────────────────────────
app.post("/hubspot/action", async (req, res) => {
  try {
    console.log("📥 HubSpot action triggered");

    const companyId =
      req.body?.object?.objectId ||
      req.body?.inputFields?.companyId ||
      req.body?.companyId;

    if (!companyId) return res.status(400).json({ error: "No companyId found" });

    const hsRes = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
      {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        params: {
          properties: ["name","domain","industry","numberofemployees","city","state","country"].join(","),
        },
      }
    );

    const props = hsRes.data.properties;
    console.log(`✅ Fetched company: ${props.name}`);

    const prompt = `You are a research assistant helping a sales team find contact information.

Research the following company and find the name, job title, email address, phone number, and LinkedIn URL of the most senior decision maker (CEO, MD, Owner, Director, or equivalent).

Company details:
- Name: ${props.name || "N/A"}
- Website: ${props.domain || "N/A"}
- Industry: ${props.industry || "N/A"}
- Location: ${[props.city, props.state, props.country].filter(Boolean).join(", ") || "N/A"}
- Employees: ${props.numberofemployees || "N/A"}

Search the web, LinkedIn, the company website, and any other public sources to find the most accurate and up-to-date contact information.

You MUST respond with ONLY a valid JSON object in this exact format — no extra text, no markdown, no explanation:
{
  "first_name": "",
  "last_name": "",
  "job_title": "",
  "email": "",
  "phone": "",
  "linkedin_url": "",
  "confidence": "high|medium|low",
  "source": "where you found this info"
}
If you cannot find a field, leave it as an empty string. Do not guess email addresses.`;

    const manusRes = await axios.post(
      "https://api.manus.im/v1/tasks",
      { prompt },
      {
        headers: {
          Authorization: `Bearer ${MANUS_API_KEY}`,
          "API_KEY": MANUS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const manusTaskId = manusRes.data?.task_id || manusRes.data?.id;
    console.log(`🚀 Manus task created: ${manusTaskId}`);

    taskMap[manusTaskId] = companyId;
    saveTaskMap(taskMap);

    // Start polling in background — Railway will check Manus every 15s
    pollManusTask(manusTaskId, companyId);

    res.status(200).json({ outputFields: { status: "processing", manusTaskId } });

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 2. Manus webhook (backup — if it ever fires)
// ─────────────────────────────────────────────
app.post("/manus/webhook", async (req, res) => {
  try {
    console.log("📥 Manus webhook received!");
    const { event_type, task_detail } = req.body;
    const taskId = task_detail?.task_id;
    if (event_type !== "task_stopped") return res.status(200).json({ received: true });
    const companyId = taskMap[taskId];
    if (!companyId) return res.status(200).json({ received: true });
    await processManusResult(taskId, companyId, task_detail?.message || "");
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Create HubSpot contact
// ─────────────────────────────────────────────
async function createHubSpotContact(contact) {
  try {
    const properties = {
      firstname: contact.first_name || "",
      lastname: contact.last_name || "",
      jobtitle: contact.job_title || "",
      ...(contact.email && { email: contact.email }),
      ...(contact.phone && { phone: contact.phone }),
      ...(contact.linkedin_url && { hs_linkedin_url: contact.linkedin_url }),
    };
    const res = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      { properties },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
    console.log(`📇 Contact created: ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    if (err.response?.status === 409 && contact.email) {
      try {
        const s = await axios.post(
          "https://api.hubapi.com/crm/v3/objects/contacts/search",
          { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: contact.email }] }] },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        const existingId = s.data.results?.[0]?.id;
        if (existingId) { console.log(`⚠️ Contact exists: ${existingId}`); return existingId; }
      } catch(e) { return null; }
    }
    console.error("❌ Failed to create contact:", err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Associate contact with company
// ─────────────────────────────────────────────
async function associateContactWithCompany(contactId, companyId) {
  try {
    await axios.put(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies/${companyId}`,
      [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 279 }],
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`🔗 Contact ${contactId} linked to company ${companyId}`);
  } catch (err) {
    console.error("❌ Failed to associate:", err.response?.data || err.message);
  }
}

app.get("/", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
