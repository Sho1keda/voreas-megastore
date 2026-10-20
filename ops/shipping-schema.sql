CREATE TABLE IF NOT EXISTS shipping_notifications (
  order_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','unknown','provider_error')),
  recipient TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  resend_id TEXT,
  updated_at TEXT NOT NULL
);
