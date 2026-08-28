# CTP AI Backend

Express API for the CTP AI Timing Planner. It provides AI advice, milestone optimization, and chat endpoints for the React frontend.

## Local development

1. Copy `.env.example` to `.env`.
2. Set the Azure OpenAI values in `.env`.
3. Install dependencies: `npm install`.
4. Start the API: `npm run dev`.

The API listens on `http://localhost:5000`. Verify it with `http://localhost:5000/health`.

`FRONTEND_URL` controls CORS. For multiple frontend environments, provide comma-separated origins.

## Production hosting

Deploy this service separately from the Vite frontend. Set `PORT` from the hosting provider, set `FRONTEND_URL` to the exact public frontend origin, and store all `MB_GENAI_*` values as hosting-provider secrets. Never commit `.env` or Azure credentials.
