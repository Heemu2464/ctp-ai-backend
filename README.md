# CTP AI Backend

Express API for the CTP AI Timing Planner. It provides AI advice, milestone optimization, and chat endpoints for the React frontend.

## Local development

1. Copy `.env.example` to `.env`.
2. Set the Azure OpenAI values in `.env`.
3. Install dependencies: `npm install`.
4. Start the API: `npm run dev`.

The API listens on `http://localhost:5000`. Verify it with `http://localhost:5000/health`.

`FRONTEND_URL` controls CORS. For multiple frontend environments, provide comma-separated origins.

## Plan ownership

The first time a browser opens the planner it must enter a corporate short ID. The API stores
that ID in the browser session, creates `BTV_STORAGE_ROOT/users/<short-id>` when needed, and
loads only that folder as **My Plans**. Plans in every other user folder are returned only as
read-only shared plans. The API never uses the Windows account of the computer hosting Node.js
as the browser user's identity.

The short-ID prompt prevents accidental cross-user access in the direct LAN setup, but it is not
company authentication: anyone who knows another person's ID could enter it. For enforced
access control, deploy behind the corporate Windows/SSO reverse proxy and have it establish the
user session from the authenticated identity.

## Production hosting

Deploy this service separately from the Vite frontend. Set `PORT` from the hosting provider, set `FRONTEND_URL` to the exact public frontend origin, and store all `MB_GENAI_*` values as hosting-provider secrets. Never commit `.env` or Azure credentials.
