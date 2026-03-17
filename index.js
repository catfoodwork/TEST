const express = require("express");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());

const HUBSPOT_TOKEN = (process.env.HUBSPOT_TOKEN || "").replace(/\s+/g, "");
const MANUS_API_KEY = ((process.env.MANUS_API_KEY_1 || "") + (process.env.MANUS_API_KEY_2 || "")).replace(/\s+/g, "");
const PORT = process.env.PORT || 3000;

// Persist taskMap to file so it survives container restarts
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

    // Fetch company properties
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
    console.log(`🔑 Manus key length: ${MANUS_API_KEY.length}, preview: ${MANUS_API_KEY.substring(0,15)}`);

    const prompt = `You are a research assistant helping a sales team find contact information.

Research the following company and find the most senior decision maker (CEO, MD, Owner, Director, or equivalent).

Company details:
- Name: ${props.name || "N/A"}
- Website: ${props.domain || "N/A"}
- Industry: ${props.industry || "N/A"}
- Location: ${[props.city, props.state, props.country].filter(Boolean).join(", ") || "N/A"}
- Employees: ${props.numberofemployees || "N/A"}

Search the web, LinkedIn, and the company website to find their contact information.

You MUST respond with ONLY a valid JSON object — no extra text, no markdown:
{
  "first_name": "",
  "last_name": "",
  "job_title": "",
  "email": "",
  "phone": "",
  "linkedin_url": "",
  "confidence": "high|medium|low",
  "source": "where you found this"
}`;

    const manusRes = await axios.post(
      "https://api.manus.im/v1/tasks",
      { prompt, webhook_url: `${process.env.BASE_URL}/manus/webhook` },
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

    res.status(200).json({ outputFields: { status: "processing", manusTaskId } });

  } catch (err) {
    console.error("❌ Error in /hubspot/action:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 2. Manus webhook — fires when task completes
// ─────────────────────────────────────────────
app.post("/manus/webhook", async (req, res) => {
  try {
    console.log("📥 Manus webhook received:", JSON.stringify(req.body));

    const { event_type, task_detail } = req.body;
    const taskId = task_detail?.task_id;

    if (event_type !== "task_stopped") return res.status(200).json({ received: true });

    const companyId = taskMap[taskId];
    if (!companyId) {
      console.warn(`⚠️ No company found for task ${taskId}`);
      return res.status(200).json({ received: true });
    }

    const message = task_detail?.message || "";
    console.log(`📄 Manus response: ${message}`);

    // Parse JSON contact from Manus
    let contact = null;
    try {
      const cleaned = message.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) contact = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("❌ Failed to parse contact JSON:", e.message);
    }

    if (!contact || (!contact.first_name && !contact.last_name)) {
      console.warn("⚠️ No valid contact found in Manus response");
      delete taskMap[taskId];
      saveTaskMap(taskMap);
      return res.status(200).json({ received: true });
    }

    console.log(`👤 Found: ${contact.first_name} ${contact.last_name} (${contact.job_title})`);

    // Create contact in HubSpot
    const contactId = await createHubSpotContact(contact);
    if (contactId) {
      await associateContactWithCompany(contactId, companyId);
      console.log(`✅ Done! Contact ${contactId} linked to company ${companyId}`);
    }

    delete taskMap[taskId];
    saveTaskMap(taskMap);
    res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌ Error in /manus/webhook:", err.response?.data || err.message);
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
      console.log("⚠️ Contact exists, finding ID...");
      try {
        const s = await axios.post(
          "https://api.hubapi.com/crm/v3/objects/contacts/search",
          { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: contact.email }] }] },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        return s.data.results?.[0]?.id || null;
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
