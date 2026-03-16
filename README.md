# HubSpot ↔ Manus.im Bridge

A lightweight Node.js backend that connects HubSpot custom workflow actions to Manus.im AI agent tasks.

## Flow
1. HubSpot workflow triggers `/hubspot/action` with a company ID
2. Backend fetches all company properties from HubSpot
3. Backend creates a Manus task with the company data
4. Manus processes and fires webhook to `/manus/webhook`
5. Backend creates a HubSpot note with Manus results on the company record

## Deploy to Railway

1. Push this code to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard:
   - `HUBSPOT_TOKEN` = your HubSpot private app token
   - `MANUS_API_KEY` = your Manus API key
   - `BASE_URL` = your Railway public URL (e.g. https://your-app.railway.app)
4. Railway auto-deploys and gives you a public URL

## Endpoints

- `GET /` — health check
- `POST /hubspot/action` — receives HubSpot workflow trigger
- `POST /manus/webhook` — receives Manus task completion
