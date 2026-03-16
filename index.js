const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const MANUS_API_KEY = process.env.MANUS_API_KEY;
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
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?associations=contacts`,
      {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        params: {
          properties: [
            "name","domain","industry","annualrevenue","numberofemployees",
            "city","state","country","phone","description","hs_lead_status",
            "lifecyclestage","createdate","notes_last_updated"
          ].join(","),
        },
      }
    );

    const company = hsRes.data;
    const props = company.properties;

    console.log(`✅ Fetched company: ${props.name}`);

    // Build prompt for Manus
    const prompt = `You are analyzing a HubSpot company record. Here is the company data:

Company Name: ${props.name || "N/A"}
Domain: ${props.domain || "N/A"}
Industry: ${props.industry || "N/A"}
Annual Revenue: ${props.annualrevenue || "N/A"}
Number of Employees: ${props.numberofemployees || "N/A"}
City: ${props.city || "N/A"}
State: ${props.state || "N/A"}
Country: ${props.country || "N/A"}
Phone: ${props.phone || "N/A"}
Description: ${props.description || "N/A"}
Lead Status: ${props.hs_lead_status || "N/A"}
Lifecycle Stage: ${props.lifecyclestage || "N/A"}

Please analyze this company and provide:
1. A brief company summary (2-3 sentences)
2. Key opportunities or insights based on the data
3. Recommended next actions for the sales team
4. Any data gaps that should be filled in

Keep the response concise and actionable for a sales team.`;

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
      outputFields: {
        status: "processing",
        manusTaskId,
      },
    });

    // Also create a note in HubSpot that the task has started
    await createHubSpotNote(
      companyId,
      `🤖 Manus AI analysis started (Task ID: ${manusTaskId}). Results will be added shortly.`
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

    const message = task_detail?.message || "No response from Manus.";
    const stopReason = task_detail?.stop_reason;

    console.log(`✅ Manus task ${taskId} stopped (${stopReason}) for company ${companyId}`);

    // Create a HubSpot note with Manus results
    await createHubSpotNote(
      companyId,
      `🤖 Manus AI Analysis Complete:\n\n${message}`
    );

    // Update the company record with a custom property (if you have one set up)
    // Uncomment and adjust property name if needed:
    // await updateHubSpotCompany(companyId, {
    //   manus_last_analysis: message.substring(0, 500),
    // });

    // Clean up task map
    delete taskMap[taskId];

    res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌ Error in /manus/webhook:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Helper: Create a HubSpot note on a company
// ─────────────────────────────────────────────
async function createHubSpotNote(companyId, body) {
  try {
    // Create the note engagement
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

    // Associate note with the company
    await axios.put(
      `https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/companies/${companyId}/note_to_company`,
      {},
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    console.log(`📝 Note created and associated with company ${companyId}`);
  } catch (err) {
    console.error("❌ Failed to create HubSpot note:", err.response?.data || err.message);
  }
}

// ─────────────────────────────────────────────
// Helper: Update HubSpot company properties
// ─────────────────────────────────────────────
async function updateHubSpotCompany(companyId, properties) {
  await axios.patch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
    { properties },
    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
  );
}

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "HubSpot-Manus bridge running" }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
