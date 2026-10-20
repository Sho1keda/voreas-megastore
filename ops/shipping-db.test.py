"""SQLite compatibility and exclusion integrity tests (no cloud calls).
Usage: python3 ops/shipping-db.test.py <private-185-seed.sql>
"""
import hashlib
import pathlib
import sqlite3
import sys

db = sqlite3.connect(':memory:')
root = pathlib.Path(__file__).parent
db.executescript((root / 'shipping-schema.sql').read_text())
db.execute("INSERT INTO shipping_notifications VALUES ('TEST:retained','hash','sent','test@example.com','123456789012','mail','2026-10-20')")
db.executescript((root / 'shipping-auto-schema.sql').read_text())
seed = pathlib.Path(sys.argv[1]).read_text()
db.executescript(seed)
db.executescript(seed)
ids = [r[0] for r in db.execute("SELECT order_id FROM shipping_exclusions WHERE batch='legacy-185-20261020' ORDER BY order_id")]
assert len(ids) == 185
assert hashlib.sha256('\n'.join(ids).encode()).hexdigest() == '1f3f9b0e694c4ed2b938742f461ab8b8e06bd0d0feca23268f546ec7588eb550'
assert db.execute('SELECT count(*) FROM shipping_notifications').fetchone()[0] == 1
claim = 'INSERT OR IGNORE INTO shipping_notifications (order_id,manifest_hash,status,recipient,tracking_number,updated_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM shipping_exclusions WHERE order_id=?)'
for order_id in ids:
    assert db.execute(claim, (order_id,'auto','pending','customer@example.com','123456789012','now',order_id)).rowcount == 0
assert db.execute(claim, ('new','auto','pending','customer@example.com','123456789012','now','new')).rowcount == 1
assert db.execute(claim, ('new','manual','pending','customer@example.com','123456789012','now','new')).rowcount == 0
db.execute("UPDATE shipping_notifications SET status='unknown' WHERE order_id='new'")
assert db.execute(claim, ('new','auto','pending','customer@example.com','123456789012','now','new')).rowcount == 0
upsert = 'INSERT INTO shipping_observations (event_id,order_id,outcome,detail,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET outcome=excluded.outcome,detail=excluded.detail,updated_at=excluded.updated_at'
db.execute(upsert, ('e','new','held','carrier','t1'))
db.execute(upsert, ('e','new','sent','','t2'))
assert db.execute('SELECT count(*) FROM shipping_observations').fetchone()[0] == 1
assert db.execute('SELECT outcome FROM shipping_observations').fetchone()[0] == 'sent'
print('PASS SQLite schemas, repeated seed, exact 185 ID digest, all 185 excluded claims, TEST retained, shared atomic claim, unknown lock, observation upsert')
