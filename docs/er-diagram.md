# ER Diagram

```mermaid
erDiagram
    USERS ||--o| PROFILES : has
    USERS ||--o| DOCTORS : "is a"
    USERS ||--o{ CONSULTATIONS : "books (patient)"
    USERS ||--o{ PAYMENTS : pays
    USERS ||--o{ REFRESH_TOKENS : owns
    USERS ||--o{ IDEMPOTENCY_KEYS : sends
    DOCTORS ||--o{ AVAILABILITY_SLOTS : offers
    DOCTORS ||--o{ CONSULTATIONS : conducts
    DOCTORS ||--o{ PRESCRIPTIONS : issues
    AVAILABILITY_SLOTS ||--o{ CONSULTATIONS : "reserved by"
    CONSULTATIONS ||--o| PRESCRIPTIONS : produces
    CONSULTATIONS ||--o{ PAYMENTS : "paid via"

    USERS {
        uuid id PK
        string email UK
        string password_hash
        enum role
        bool mfa_enabled
        string mfa_secret_enc
        int mfa_last_step
    }
    PROFILES {
        uuid id PK
        uuid user_id FK
        string full_name
        string phone_enc
        date date_of_birth
    }
    DOCTORS {
        uuid id PK
        uuid user_id FK
        string specialization
        string license_number UK
        decimal consultation_fee
        bool is_verified
    }
    AVAILABILITY_SLOTS {
        uuid id PK
        uuid doctor_id FK
        timestamptz start_time
        timestamptz end_time
        enum status
        timestamptz held_until
        int version
    }
    CONSULTATIONS {
        uuid id PK
        uuid patient_id FK
        uuid doctor_id FK
        uuid slot_id FK
        enum status
        timestamptz scheduled_at
        string notes_enc
    }
    PRESCRIPTIONS {
        uuid id PK
        uuid consultation_id FK
        uuid doctor_id FK
        uuid patient_id FK
        string content_enc
    }
    PAYMENTS {
        uuid id PK
        uuid consultation_id FK
        decimal amount
        enum status
        string idempotency_key UK
    }
    AUDIT_LOGS {
        bigint id PK
        timestamptz created_at PK
        uuid actor_id
        string action
        string entity_type
        string entity_id
        jsonb metadata
    }
    IDEMPOTENCY_KEYS {
        uuid id PK
        uuid user_id FK
        string key
        string request_hash
        json response_body
    }
    REFRESH_TOKENS {
        uuid id PK
        uuid user_id FK
        string token_hash UK
        timestamptz expires_at
        bool mfa_verified
    }
    OUTBOX_EVENTS {
        uuid id PK
        string type
        string aggregate_id
        jsonb payload
        enum status
        int attempts
        timestamp available_at
    }
    DAILY_STATS {
        date day PK
        int total
        int completed
        int cancelled
        int no_show
        decimal revenue
    }
```

`AUDIT_LOGS` has no foreign keys by design: append-only, cheap writes, and it survives user deletion.
It is **range-partitioned by month** on `created_at` (so the primary key is `(id, created_at)`), and a database trigger
rejects UPDATE and DELETE, so rows can only be appended.

`OUTBOX_EVENTS` is the transactional outbox: written in the same transaction as the state change it announces,
delivered later by the worker with retry and exponential backoff. `DAILY_STATS` is the pre-aggregated table behind the
admin analytics. Neither has foreign keys.

Two database constraints do the heavy lifting for booking correctness (see the slot migration):
`no_overlapping_slots` (exclusion constraint) and `uniq_active_consultation_per_slot` (partial unique index).
