CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE availability_slots
  ADD CONSTRAINT slot_time_valid CHECK (end_time > start_time);

ALTER TABLE availability_slots
  ADD CONSTRAINT no_overlapping_slots
  EXCLUDE USING gist (doctor_id WITH =, tsrange(start_time, end_time) WITH &&)
  WHERE (status <> 'CANCELLED');

CREATE UNIQUE INDEX uniq_active_consultation_per_slot
  ON consultations (slot_id) WHERE status <> 'CANCELLED';
