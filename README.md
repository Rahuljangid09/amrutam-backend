# Amrutam telemedicine backend

Node.js + TypeScript + Express + PostgreSQL (Prisma) + Redis. Modular monolith with a separate background worker.

## What it does
Patients search doctors and **book a slot** (hold, pay, confirm); doctors run the **consultation lifecycle** and issue
**encrypted prescriptions**; admins get **analytics and an audit trail**. Full API: `docs/openapi.yaml`.

| Area | Where | Key idea |
|---|---|---|
| Auth, RBAC, MFA | `src/modules/auth`, `src/common/auth.ts` | JWT access + rotating refresh tokens with reuse detection; TOTP MFA with replay protection |
| Booking saga | `src/modules/bookings`, `payments` | hold slot -> pay -> confirm, with compensation on failure / expiry |
| Idempotency | `src/common/idempotency.ts` | `Idempotency-Key` required on booking, payment, prescription |
| Double-booking protection | `prisma/migrations/*slot_constraints` | conditional UPDATE + exclusion constraint + partial unique index |
| Consultations | `src/modules/consultations` | state machine; every transition is `UPDATE ... WHERE status = expected` |
| Prescriptions | `src/modules/prescriptions` | AES-256-GCM, key ring, ciphertext bound to its row (AAD); reads are audited |
| Audit | `src/common/audit.ts` | written in the same transaction; `audit_logs` is monthly-partitioned and append-only (trigger) |
| Async work | `src/worker.ts`, `src/jobs` | outbox delivery with retry + backoff, hold expiry, daily stats, housekeeping |
| Analytics | `src/modules/admin` | `daily_stats` is pre-aggregated; audit log uses keyset pagination |
| Observability | `src/common/metrics.ts`, `src/tracing.ts` | Prometheus metrics, request ids, OpenTelemetry traces, health/readiness |

## Setup (Windows PowerShell)
```powershell
cd D:\Dev\amrutam-backend
npm install
Copy-Item .env.example .env         # then: npm run gen-secrets  and paste JWT_ACCESS_SECRET + ENCRYPTION_KEYS into .env
docker compose down -v --remove-orphans   # clears any old dev database
docker compose up -d                # Postgres (host port 5433) + Redis
npx prisma migrate reset --force    # applies all 4 migrations to a fresh dev database, then generates the client
npm run create-admin -- admin@amrutam.dev "Passw0rd!Admin"
npm run dev                         # API on :3000
npm run dev:worker                  # second terminal: background worker
```
`prisma/migrations` holds four migrations in order: `init`, `slot_constraints`, `mfa_outbox_daily_stats`, `audit_log_partitioning`.

## Tests
Tests use a **separate** database (`amrutam_test`, see `.env.test`) and refuse to run against any database whose name does not end in `_test`.
```powershell
docker exec amrutam-postgres psql -U amrutam -d postgres -c "CREATE DATABASE amrutam_test"
$env:DATABASE_URL="postgresql://amrutam:amrutam@localhost:5433/amrutam_test"; npx prisma migrate deploy; Remove-Item Env:DATABASE_URL
npm test                            # or: npm run test:coverage
```
Covered: concurrent booking (30 patients race for one slot), idempotent replay/mismatch/in-progress, payment success/failure/expiry
compensation, cancellation and refunds, consultation state machine, prescription access rules, MFA, refresh-token reuse,
admin analytics, outbox retry/DEAD, key rotation, and Redis being down/late.

## Demo flow (Postman)
1. `POST /auth/login` as admin -> `POST /doctors` -> login as that doctor -> `POST /slots`
2. `POST /auth/register` + login as a patient -> `GET /doctors` -> `GET /doctors/{id}/slots`
3. `POST /bookings` with header `Idempotency-Key: <any uuid>` -> send it **again**: same response, `Idempotent-Replayed: true`
4. `POST /payments/{paymentId}/pay` (`{"outcome":"success"}` or `"failure"`)
5. Doctor: `POST /consultations/{id}/start` (from 10 min before the slot) -> `/complete` -> `POST /consultations/{id}/prescription`
6. Patient: `GET /consultations/{id}/prescription`; admin: `GET /admin/audit-logs`, `GET /admin/analytics/overview`

## Everything in containers
```powershell
docker compose -f docker-compose.full.yml up --build     # API :3000, Prometheus :9090, Grafana :3001 (admin/admin), Jaeger :16686
```
`infra/k8s` has Kubernetes manifests (3 replicas, HPA, PDB, probes, migration Job); `.github/workflows/ci.yml` runs
type-check, tests + coverage, `npm audit`, secret scan, CodeQL, image build + Trivy scan, push to GHCR, optional deploy.

## Key rotation
`ENCRYPTION_KEYS=v1:<old>,v2:<new>` -> `ENCRYPTION_ACTIVE_KEY_ID=v2` -> `npm run rotate-keys` -> remove `v1` when it reports zero.

## Honest limits
- Payments are a **mock gateway** (`/payments/{id}/pay`); a real one needs a provider webhook with signature verification.
- Notifications are logged, not sent: the outbox handlers in `src/jobs/outbox.ts` are the place to plug in email/SMS.
- Access tokens live 15 minutes, so a deactivated user's existing access token works until it expires (refresh tokens are revoked at once).
- Run the database in UTC (the Docker image is).
