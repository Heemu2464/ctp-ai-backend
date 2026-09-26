# Mission 865 Gate 4B Acceptance Evidence

## Automated Evidence

| Requirement | Automated test | Browser test | Manual test | Result | Evidence | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| Protected Build is immutable | Recovery service | None configured | Case 4 | Pass | `recoveryService.test.js` | Browser confirmation pending |
| Protected Rule is immutable | Recovery service | None configured | Case 5 | Pass | `recoveryService.test.js` | Browser confirmation pending |
| Constraint add and duplicate clarification | `/ai-chat` endpoint | None configured | Cases 4-5 | Pass | `recovery-endpoint.test.mjs` | Clarified-target continuation is manual |
| Alternative options | `/ai-chat` endpoint | None configured | Case 8 | Pass | `recovery-endpoint.test.mjs` | Browser confirmation pending |
| Explicit target lane | `/ai-chat` endpoint | None configured | Cases 1-3 | Pass | `recovery-endpoint.test.mjs` | Final click path is manual |
| Copy safety and dependency remapping | Recovery service | None configured | Cases 2-3 | Pass | `recoveryService.test.js` | Persisted browser flow pending |
| Actual Execution isolation | Recovery service | None configured | Cases 1-3 | Pass | `recoveryService.test.js` | Persisted browser flow pending |
| Cancellation and expiry | `/ai-chat` endpoint | None configured | Case 11 | Pass | `recovery-endpoint.test.mjs` | Cross-surface browser check pending |
| Protected-date stale rejection | `/ai-chat` endpoint | None configured | Case 13 | Pass | `recovery-endpoint.test.mjs` | Persisted UI check pending |
| Persistence failure and rollback | No test hook | None configured | Case 14 | Not proven | None | No existing injectable save failure/revision hook |
| Single-write enforcement | No UI harness | None configured | Case 15 | Not proven | None | Requires UI/save-boundary instrumentation |
| Shared standalone/Tracker surface | Shared React state | Playwright shared-preview flow | Case 12 | Pass | `timing-planner/e2e/recovery-preview.spec.js` | Copy/apply completion remains manual |
| Preview is non-destructive | Recovery service | Playwright preview/clear flow | Case 9 | Pass | `timing-planner/e2e/recovery-preview.spec.js` | Hidden-row focus remains manual |
| Refresh during preview | Recovery service | Playwright refresh flow | Case 15 | Pass | `timing-planner/e2e/recovery-preview.spec.js` | Apply/copy refresh remains manual |

## Commands Run

```powershell
npm --prefix "C:\Users\SABADDI\timing-planner" test
npm --prefix "C:\Users\SABADDI\Documents\ctp-ai-backend" test
npm --prefix "C:\Users\SABADDI\timing-planner" run build
Set-Location "C:\Users\SABADDI\Documents\ctp-ai-backend"; node --check server.js
```

## Manual Checklist

| Case | Preconditions and action | Expected result | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Prepare My Plan recovery; apply to My Plan | Only editable planned dates change; actuals and protected data do not | Pending operator run | Add local screenshot-free note | Pending |
| 2 | Copy My Plan recovery to My Plan 2 | Source unchanged; internal dependencies remapped | Service-tested | `recoveryService.test.js` | Partial |
| 3 | Reverse copy My Plan 2 to My Plan | Source unchanged; internal dependencies remapped | Service-tested | `recoveryService.test.js` | Partial |
| 4 | Protect Build Plan B-Build | Build is read-only and preview names constraint | Service/endpoint-tested | Test files above | Partial |
| 5 | Protect Rule-Based milestone | Rule is read-only and preview names constraint | Service-tested | `recoveryService.test.js` | Partial |
| 6 | Update minimum gap | Options regenerate without writes | Pending operator run | Add local note | Pending |
| 7 | Remove constraint | Options regenerate without writes | Pending operator run | Add local note | Pending |
| 8 | Show another option | Preview changes only | Endpoint-tested | `recovery-endpoint.test.mjs` | Partial |
| 9 | Show on Timeline / hidden row | No plan write and rows focus | Pending operator run | Add local note | Pending |
| 10 | Cancel in Tracker after global preview | Both panels clear executable state | Pending operator run | Add local note | Pending |
| 11 | Use an expired session | Recovery is rejected | Endpoint-tested | `recovery-endpoint.test.mjs` | Partial |
| 12 | Change protected date then apply | Old recovery is rejected as stale | Endpoint-tested | `recovery-endpoint.test.mjs` | Partial |
| 13 | Force persistence failure | No success and committed state remains | Not executable with current hooks | None | Blocked |
| 14 | Confirm twice | Exactly one save | Pending instrumentation | None | Pending |
| 15 | Refresh after success/failure | Correct committed state reloads | Pending operator run | Add local note | Pending |

## Decision

Gate 4B is **not closed**. Endpoint, service, and minimal browser evidence are passing, but persistence-failure/single-write coverage plus browser copy/apply/cancel/undo completion remain unproven because there is no existing injectable save failure or revision-conflict boundary.