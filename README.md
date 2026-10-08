# CTP AI Backend

Express API for the CTP AI Timing Planner. It provides AI advice, milestone optimization, and chat endpoints for the React frontend.

## Local development

1. Copy `.env.example` to `.env`.
2. Set the Azure OpenAI values in `.env`.
3. Install dependencies: `npm install`.
4. Start the API: `npm run dev`.

The API listens on `http://localhost:5000`. Verify it with `http://localhost:5000/health`.

`FRONTEND_URL` controls CORS. For multiple frontend environments, provide comma-separated origins.

## Plan ownership and sign-in

Authentication is local and file-based for a controlled internal pilot:

1. `POST /api/auth/register` with `{ shortId, displayName, email, password }` creates a `pending` user.
2. Admin approves the account in `User Admin` UI or via `PATCH /api/admin/users/:id/status`.
3. `POST /api/auth/login` with `{ identifier, password }` creates the session for approved users.
4. `GET /api/auth/me` returns the current user; `POST /api/auth/logout` destroys the session.

User records are stored at `BTV_AUTH_STORAGE_ROOT/auth/users.json` when configured, otherwise `BTV_STORAGE_ROOT/auth/users.json`, with secure password hashes and approval/lock metadata. Keep plan data on the corporate share, but set `BTV_AUTH_STORAGE_ROOT` to a backend-private local folder if the share cannot enforce the required credential ACLs. Both the server and admin CLI use this setting. Existing accounts are not silently moved; verify and migrate any existing store before switching locations.

Use this script to bootstrap the first admin account:

```bash
npm run auth:create-admin -- --shortId abcdefg --displayName "Admin User" --email admin@example.com
```

The script prompts twice without echoing the password. Never pass passwords in arguments, environment variables, logs, support tickets or chat. Duplicate IDs/emails are rejected without overwriting or promoting accounts. Environment-based admin bootstrap is removed. Stop the backend and watchdog before CLI writes, then restart: file storage is single-process, not a multi-writer database. Use the same dedicated OS identity for the CLI and server.

## Password security and manual reset

Passwords use `bcryptjs` 2.4.3, with automatic per-password random salts and cost 12 (optional `BCRYPT_COST=12..15`). `auth/passwordService.js` owns hashing, verification and the policy: at least 10 characters, uppercase/lowercase/digit/symbol, maximum 72 UTF-8 bytes. Library `bcrypt.compare` performs verification. Hashes are one-way, not encrypted passwords; there is no old-password retrieval endpoint or admin view.

`POST /api/admin/users/:id/reset-password` with an empty body marks the account reset-required and invalidates existing sessions. It rejects administrator-supplied replacement passwords. There is deliberately no unauthenticated self-service reset or permanent temporary password.

Controlled pilot reset procedure:

1. Independently verify the account holder and internal user ID using the approved organizational procedure, not only an email or claimed Short ID.
2. Stop the backend and watchdog, using the service OS identity on a trusted host.
3. Run `npm run auth:create-admin -- --reset-user-id <internal-user-id>`. Confirm `VERIFIED` only after step 1.
4. The verified account holder enters a new private password twice directly into the hidden trusted terminal. Do not send a password to an operator or assistant. This requires supervised trusted-host access; remote self-service reset is not implemented.
5. Restart the backend and watchdog. The old password and earlier sessions no longer work; approval status and plan ownership are unchanged.

Storage is JSON at `(BTV_AUTH_STORAGE_ROOT || BTV_STORAGE_ROOT)/auth/users.json`, outside frontend static assets. The backend has no static user-store route; Vite denies auth/private-data access. User stores and temporary files are Git-ignored in both roots. On POSIX, the auth directory/file use 0700/0600; on Windows, ACLs allow only the service identity, SYSTEM and local Administrators. Startup fails closed if permissions cannot be applied or storage is corrupt/unreadable. Verify SMB share permissions as well as filesystem ACLs; physical host/storage administrators remain trusted. Atomic writes use exclusive restrictive temporary files, flush before rename, and remove temporary files on failure.

Startup migrates recognized plaintext password fields to salted hashes once, removes legacy credential fields, requires manual reset for unsupported credentials, and invalidates old sessions. Re-running migration preserves hashes. It creates no plaintext backup, but cannot securely erase historical backups, filesystem versions, logs or previously committed credentials. Before first hardened startup, inventory historical copies under restricted administrator access and remove/rotate them according to policy without publishing their contents.

API/admin serializers are explicit allowlists. Sessions contain identity and a credential version only. Frontend password fields are transient component state, cleared immediately on submission and on failure/success/mode change; they are not placed in browser storage or planner exports. Auth request bodies are not logged; uncaught request failures return a generic error.

Limitations: HTTPS with secure cookies is still required for network use; a strong session secret and trusted hosts are mandatory. MemoryStore and file queues support one backend instance. There is account lockout but no comprehensive IP/distributed abuse limiter; production deployment needs one and a durable session/user store. JavaScript strings cannot be reliably zeroized from memory. The configured live UNC store was absent during the audit (`ENOENT`), so real records, remote ACLs, historical copies and live migration were not verified.

Plan ownership is enforced by internal `ownerUserId` (not by client-provided owner values). Existing plans are backfilled at runtime:

- Matching local user found by legacy folder/owner short ID: set `ownerUserId` to that user's internal id.
- No matching user: set `ownerUserId` to `UNASSIGNED` (nobody can edit it). When the matching Short ID later registers, those plans are reassigned to that account on the next backend start.

Shared Plans (`GET /api/plans/shared`) lists every other user's plan as read-only, without internal owner IDs or file paths. Any signed-in user can copy one with `POST /api/plans/copy`, which creates their own baseline copy. Only the owner can save, edit or delete a plan.

The server refuses to start if `SESSION_SECRET` is shorter than 32 characters.

**Without HTTPS, session cookies and plan data travel unencrypted on the network.** Set `COOKIE_SECURE=true` once the app is served over HTTPS.

## Production hosting

Deploy this service separately from the Vite frontend. Set `PORT` from the hosting provider, set `FRONTEND_URL` to the exact public frontend origin, and store all `MB_GENAI_*` and `SESSION_SECRET` values as hosting-provider secrets. Never commit `.env` or credentials, and never put secrets in `VITE_` variables (they are shipped to the browser).

## Local Auth Audit Record

Registration availability follow-up: the corporate share was reachable, but restrictive credential ACL initialization failed, making all requests return HTTP 500. No user store existed on that share. The hosting configuration now sets `BTV_AUTH_STORAGE_ROOT=C:\Users\SABADDI\Documents\ctp-ai-backend\private-data`, so credentials reside at `private-data/auth/users.json` with restrictive local ACLs; plan storage is unchanged. After restart, live health returned 200 and backend/frontend-proxy auth checks returned the normal signed-out 401. Test fixtures explicitly override both roots. The separate-storage regression checks registration succeeds without placing credentials in plan storage. The original audit record below describes the configuration before this follow-up.

### A. Storage

The inspected configuration resolves to `\\clcaeshare.in623.corpintra.net\RD-IDA\02_IDA_Projects\01_Comp_Dev_AMG\01_Chassis Add on & ADAS\99_Miscellaneous\Hemanth Sai\BTV_Planner\auth\users.json`. This is backend-managed JSON on a shared filesystem, not a database or exclusively local disk. Inspection returned `ENOENT`; no live passwords or hashes were printed or inspected. `.env` is untracked. No tracked user-store/capture files were found. An old untracked captured-mail file was discovered and excluded, not read or deleted.

### B. Hashing

`auth/passwordService.js`: `hashPassword(plainPassword)` uses `bcryptjs` 2.4.3 and fresh automatic salts; `verifyPassword(plainPassword, storedHash)` delegates to `bcrypt.compare`, not plaintext equality. Cost defaults to 12 with validated 12-15 configuration. Registration, manual admin creation and manual reset use the same utility. Existing valid bcrypt hashes remain compatible. This does not provide password decryption or recovery. No SHA/MD5/base64/custom password hashing or reversible password encryption was introduced.

### C. Exposure

Allowlist serializers cover registration, login, current-user, debug and admin responses. Sessions store identity and credential version only. Password fields clear at submission and all outcomes; passwords are absent from localStorage/sessionStorage and rendered page text in browser tests. Auth inputs are not logged, errors are generic, backend HTTP storage access and Vite filesystem access are blocked. Hashes remain exclusively in the protected backend user store. Historical copies remain an operator responsibility.

### D. Changes

Created: backend `auth/passwordService.js`.

Modified backend: `auth/localAuth.js`, `auth/localRoutes.js`, `auth/localMiddleware.js`, `server.js`, `scripts/create-admin.js`, `test/auth-unit.test.mjs`, `test/auth-flow.test.mjs`, `.gitignore`, `.env.example`, `README.md`.

Modified frontend: `src/authFlow.js`, `src/authFlow.test.js`, `e2e/auth-helpers.js`, `e2e/sign-in.spec.js`, `e2e/app-smoke.spec.js`, `playwright.config.js`, `vite.config.js`, `.gitignore`.

No packages added, upgraded or removed during this audit; `bcryptjs` was already installed. No existing files deleted. Production environment-password bootstrap and admin-assigned password behavior were removed. Unrelated existing worktree changes were preserved. Planner implementations were not edited by this audit.

### E. Executed Checks

Commands below use `BACKEND=C:\Users\SABADDI\Documents\ctp-ai-backend` and `FRONTEND=C:\Users\SABADDI\timing-planner`. Repeated focused runs are grouped with their failures and final outcomes; no failure is counted as a pass.

| Command / inspection | Actual result |
| --- | --- |
| Initial `rg` search | Unavailable; PowerShell CommandNotFoundException. File/search tools used instead. |
| `Set-Location` to backend/frontend roots | Successful; frontend root used for Playwright/config-relative commands. |
| Safe metadata ESM script via `node --input-type=module` | Confirmed bcryptjs 2.4.3, configured path, `.env` untracked, no environment admin password, no tracked sensitive files; live store `ENOENT`. Printed metadata only. |
| `node --test BACKEND/test/auth-unit.test.mjs` (repeated) | Initial hashing checks 4/4; one session fixture argument failed (10/11), corrected; final expanded suite 11/11, including actual Windows ACLs. |
| `node --test BACKEND/test/auth-flow.test.mjs BACKEND/test/auth-unit.test.mjs` (also reverse argument order) | Initial 7/7; ACL rewrite issue 18/19, repaired and rerun 19/19. |
| `node --test BACKEND/test/auth-flow.test.mjs` | 8/8 API/security integration tests passed. |
| `npm --prefix FRONTEND exec -- vitest run FRONTEND/src/authFlow.test.js` | Failed: npm retained backend root; no tests found. |
| `npm --prefix FRONTEND exec -- vitest run --root FRONTEND src/authFlow.test.js` | Failed: npm/PowerShell option forwarding; no tests found. |
| `node FRONTEND/node_modules/vitest/vitest.mjs run --root=FRONTEND src/authFlow.test.js` | 14/14 passed. |
| Two empty-temp-file ACL diagnostic scripts via `node --input-type=module`, invoking `powershell.exe -NoProfile -NonInteractive -Command ...` | Restricted file ACL and complete directory/file routine succeeded; no live data accessed. |
| `npx playwright test e2e/sign-in.spec.js --project=chromium` (repeated) | First 1/2: wrong accessible-label locator, repaired; subsequent and final cleanup run 2/2 passed. |
| `npm --prefix BACKEND test` | 27/27 passed: auth, ownership, storage workflow, read lanes and recovery endpoints. |
| `npm --prefix FRONTEND test` | 62/62 passed across six frontend test files. |
| `npm --prefix FRONTEND run test:e2e` | First 5/9: four 30-second timeouts. Fixture-inclusive Windows budget changed to 60 seconds; rerun 9/9 passed. |
| `npm --prefix FRONTEND run build` | Passed; existing large-chunk warning remains. |
| `npx eslint src/authFlow.js src/authFlow.test.js e2e/auth-helpers.js e2e/sign-in.spec.js e2e/app-smoke.spec.js playwright.config.js vite.config.js` | First two `process` no-undef errors; explicit imports added; rerun passed. |
| `node --check` for `server.js`, `scripts/create-admin.js`, and all four auth modules | All six passed. |
| `git -C BACKEND status --short`; `git -C FRONTEND status --short` | Existing dirty worktrees inspected without printing contents; unrelated changes retained. |
| `git -C BACKEND diff --check`; `git -C FRONTEND diff --check` | Passed; Git reported LF/CRLF normalization warnings, not whitespace defects. |
| `node --test --test-name-pattern="both Git roots" BACKEND/test/auth-unit.test.mjs` | 1/1 passed: user stores, temporary files, captures and `.env` excluded. |
| Editor diagnostics and targeted secret-handling searches | No diagnostics in touched runtime/config files; password hashing/verification calls confined to the dedicated service. |

Security proofs exercised by those tests:

1. Registration persists a bcrypt hash only, not a password/confirmation.
2. Hash differs from the original input and carries the expected bcrypt format/cost.
3. Equal passwords generate different salted hashes.
4. Correct password verifies through the dedicated library.
5. Wrong password is rejected with a generic credential error.
6. A stored hash submitted as a password cannot authenticate.
7. Weak/missing/non-string input cannot be hashed or coerced into a credential.
8. ASCII and multibyte UTF-8 inputs above 72 bytes are rejected.
9. Unsafe/configuration work factors are rejected.
10. Pending/rejected/disabled accounts cannot authenticate.
11. Lockout triggers after repeated failures and controlled unlock restores access.
12. Manual admin creation persists a cost-12 hash without the input.
13. Duplicate admin creation cannot replace a password or promote an account.
14. Admin CLI refuses password arguments and returns only safe operation metadata.
15. Legacy plaintext migration hashes valid inputs and removes secret fields.
16. Migration is idempotent and leaves no temporary/plaintext backup files.
17. Unsupported credentials require reset rather than unsafe verification.
18. Reset makes the old password fail and the new private password succeed.
19. Reset creates a new cost-12 hash without storing the new input.
20. Previous sessions are denied after reset; session payload contains no credentials.
21. Auth/current-user/debug/admin success and error responses omit hashes/passwords.
22. Administrator API cannot choose a replacement permanent password.
23. Auth success/error logs contain neither test passwords nor malformed-store secrets.
24. Browser fields clear, browser storage/text omit passwords, and backend/Vite user-store HTTP retrieval is denied.
25. Actual Windows owner/principal ACLs and both repositories' secret-file exclusions are enforced.

Application regression coverage includes ownership, owner-only baseline copies, journals/storage, read tools, actuals/dependencies/actions, home controls, guided-tour launcher, reminders, tracker pan/zoom/layers, export dialog, sub-activities, chatbot recovery preview and refresh. Passing existing coverage is not a claim that every manual import/export variant was exhaustively tested.

### F. Remaining Limits

No live user file, remote ACLs, historical backups, remote reset operation or organizational identity-verification procedure was available to verify. The hidden terminal reset requires trusted-host access and an independently verified user; no email/self-service flow is claimed. HTTPS/secure cookies, dedicated service identity, SMB share restrictions and historical-artifact review remain deployment requirements. File persistence/MemoryStore are single-instance, not production distributed infrastructure. Test accounts are artificial and isolated, with randomized browser credentials; no real credentials were printed or used in assertions.
