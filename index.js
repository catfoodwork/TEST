const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const HUBSPOT_TOKEN = (process.env.HUBSPOT_TOKEN || "pat-na1-435522dd-934c-4036-95f8-479d10311ccc").replace(/\s+/g, "");
const MANUS_API_KEY = (process.env.MANUS_API_KEY || "sk-7062Zkwv1y-_CjVqXV3ZMM1GWOZ7_KCglXKcgQ_QYi32YhmwYPhWuTy37vAO-8LFzFxJEyiCynAlJUz7").replace(/\s+/g, "");
const PORT = process.env.PORT || 3000;

// Store active tasks: manusTaskId -> hubspot companyId
const taskMap = {};

// ─────────────────────────────────────────────
// 1. HubSpot Custom Action triggers this endpoint
// ─────────────────────────────────────────────
app.post("/hubspot/action", async (req, res) => {
  try {
    console.log("📥 HubSpot action triggered:", JSON.stringify(req.body));

    const companyId =
      req.body?.object?.objectId ||
      req.body?.inputFields?.companyId ||
      req.body?.companyId;

    if (!companyId) {
      console.error("No companyId found in payload:", req.body);
      return res.status(400).json({ error: "No companyId found" });
    }

    // Fetch all company properties from HubSpot
    const hsRes = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
      {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        params: {
          properties: [
            "name","domain","industry","annualrevenue","numberofemployees",
            "city","state","country","phone","description"
          ].join(","),
        },
      }
    );

    const props = hsRes.data.properties;
    console.log(`✅ Fetched company: ${props.name}`);

    // Build prompt — ask Manus to find manager and return structured JSON
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

    // Create Manus task
    const manusRes = await axios.post(
      "https://api.manus.im/v1/tasks",
      {
        prompt,
        webhook_url: `${process.env.BASE_URL}/manus/webhook`,
      },
      {
        headers: {
          Authorization: `Bearer ${MANUS_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const manusTaskId = manusRes.data?.task_id || manusRes.data?.id;
    console.log(`🚀 Manus task created: ${manusTaskId}`);

    // Store mapping
    taskMap[manusTaskId] = companyId;

    // Respond to HubSpot immediately
    res.status(200).json({
      outputFields: { status: "processing", manusTaskId },
    });

    // Create a note that research has started
    await createHubSpotNote(
      companyId,
      `🔍 Manus AI is researching the key decision maker for this company. A contact will be created and associated shortly.`
    );

  } catch (err) {
    console.error("❌ Error in /hubspot/action:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 2. Manus fires this webhook when task completes
// ─────────────────────────────────────────────
app.post("/manus/webhook", async (req, res) => {
  try {
    console.log("📥 Manus webhook received:", JSON.stringify(req.body));

    const { event_type, task_detail } = req.body;
    const taskId = task_detail?.task_id;

    // Only act on task completion
    if (event_type !== "task_stopped") {
      return res.status(200).json({ received: true });
    }

    const companyId = taskMap[taskId];
    if (!companyId) {
      console.warn(`⚠️ No company found for Manus task ${taskId}`);
      return res.status(200).json({ received: true });
    }

    const message = task_detail?.message || "";
    console.log(`✅ Manus task ${taskId} completed for company ${companyId}`);
    console.log(`📄 Manus response: ${message}`);

    // Parse the JSON contact info from Manus response
    let contact = null;
    try {
      const cleaned = message.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        contact = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.error("❌ Failed to parse Manus JSON response:", parseErr.message);
    }

    if (!contact || (!contact.first_name && !contact.last_name)) {
      await createHubSpotNote(
        companyId,
        `🤖 Manus AI could not find a verified decision maker contact for this company.\n\nManus response:\n${message}`
      );
      delete taskMap[taskId];
      return res.status(200).json({ received: true });
    }

    console.log(`👤 Found contact: ${contact.first_name} ${contact.last_name} (${contact.job_title})`);

    // Create the contact in HubSpot
    const contactId = await createHubSpotContact(contact);

    if (contactId) {
      // Associate the contact with the company
      await associateContactWithCompany(contactId, companyId);

      // Create a summary note on the company
      await createHubSpotNote(
        companyId,
        `✅ Manus AI found and created a contact:\n\n👤 ${contact.first_name} ${contact.last_name}\n💼 ${contact.job_title || "N/A"}\n📧 ${contact.email || "N/A"}\n📞 ${contact.phone || "N/A"}\n🔗 ${contact.linkedin_url || "N/A"}\n\n📊 Confidence: ${contact.confidence || "N/A"}\n🔍 Source: ${contact.source || "N/A"}`
      );

      console.log(`✅ Contact ${contactId} created and associated with company ${companyId}`);
    } else {
      await createHubSpotNote(
        companyId,
        `⚠️ Manus found contact info but failed to create it in HubSpot:\n\n${JSON.stringify(contact, null, 2)}`
      );
    }

    delete taskMap[taskId];
    res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌ Error in /manus/webhook:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Helper: Create a HubSpot contact
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

    console.log(`📇 HubSpot contact created: ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    // If contact already exists (409), find and return existing ID
    if (err.response?.status === 409 && contact.email) {
      console.log("⚠️ Contact already exists, fetching existing...");
      try {
        const searchRes = await axios.post(
          "https://api.hubapi.com/crm/v3/objects/contacts/search",
          {
            filterGroups: [{
              filters: [{
                propertyName: "email",
                operator: "EQ",
                value: contact.email,
              }]
            }]
          },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        return searchRes.data.results?.[0]?.id || null;
      } catch (searchErr) {
        console.error("❌ Failed to find existing contact:", searchErr.message);
        return null;
      }
    }
    console.error("❌ Failed to create contact:", err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Helper: Associate contact with company
// ─────────────────────────────────────────────
async function associateContactWithCompany(contactId, companyId) {
  try {
    await axios.put(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies/${companyId}/contact_to_company`,
      {},
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
    console.log(`🔗 Contact ${contactId} associated with company ${companyId}`);
  } catch (err) {
    console.error("❌ Failed to associate contact:", err.response?.data || err.message);
  }
}

// ─────────────────────────────────────────────
// Helper: Create a HubSpot note on a company
// ─────────────────────────────────────────────
async function createHubSpotNote(companyId, body) {
  try {
    const noteRes = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/notes",
      {
        properties: {
          hs_note_body: body,
          hs_timestamp: Date.now().toString(),
        },
      },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    const noteId = noteRes.data.id;

    await axios.put(
      `https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/companies/${companyId}/note_to_company`,
      {},
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    console.log(`📝 Note created on company ${companyId}`);
  } catch (err) {
    console.error("❌ Failed to create note:", err.response?.data || err.message);
  }
}

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "HubSpot-Manus bridge running" }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
