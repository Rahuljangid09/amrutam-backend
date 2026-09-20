-- Audit logs become a range-partitioned table (monthly, by created_at).
-- Why: it is the highest-volume, append-only table; partitions keep indexes small,
-- make retention a cheap DROP of an old partition, and keep recent data hot.
--
-- Safety guard: nothing wrote to audit_logs before this release. Refuse to drop real data.
DO $$
BEGIN
  IF (SELECT count(*) FROM "audit_logs") > 0 THEN
    RAISE EXCEPTION 'audit_logs is not empty; refusing to convert to a partitioned table automatically';
  END IF;
END $$;

DROP TABLE "audit_logs";

CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "actor_role" "Role",
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id","created_at")
) PARTITION BY RANGE ("created_at");

CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- Safety net: rows outside any monthly partition still land somewhere (never fail a request).
CREATE TABLE "audit_logs_default" PARTITION OF "audit_logs" DEFAULT;

-- Creates monthly partitions from start_month for months_ahead + 1 months. Idempotent.
-- Returns how many partitions it created (an integer, because Prisma cannot read void results).
CREATE OR REPLACE FUNCTION ensure_audit_partitions(start_month date, months_ahead integer)
RETURNS integer AS $$
DECLARE
  m date;
  part text;
  created integer := 0;
BEGIN
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', start_month) + make_interval(months => i))::date;
    part := format('audit_logs_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$ LANGUAGE plpgsql;

-- One month back (late clock skew), current month, and 12 months ahead.
SELECT ensure_audit_partitions((date_trunc('month', now()) - interval '1 month')::date, 13);

-- Compliance: audit rows can never be changed or deleted through SQL row operations.
-- (Retention = DROP an old partition, which is a deliberate DBA action.)
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
