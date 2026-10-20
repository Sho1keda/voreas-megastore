-- Additive migration; do not recreate shipping_notifications or fake sent rows.
CREATE TABLE IF NOT EXISTS shipping_exclusions (
  order_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  decision_ref TEXT NOT NULL,
  batch TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS shipping_observations (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shipping_observations_order ON shipping_observations(order_id);
