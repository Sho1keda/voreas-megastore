// Generate private SQL from the reviewed 185-row CSV. No names/emails exported.
// Usage: node ops/seed-shipping-exclusions.mjs <csv> <output.sql>
import fs from 'node:fs';
import crypto from 'node:crypto';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('CSV and output SQL paths required');
const csv = fs.readFileSync(input, 'utf8');
const ids = csv.trim().split(/\r?\n/).slice(1).map(line => /^"([a-zA-Z0-9]+)",/.exec(line)?.[1]);
if (ids.length !== 185 || ids.some(id => !id) || new Set(ids).size !== 185) throw Error('Expected exactly 185 unique valid order IDs');
const hash = crypto.createHash('sha256').update(csv).digest('hex');
const rows = ids.map(id => `('${id}', 'S I decision: already delivered; do not notify', 'message:6982156; csv-sha256:${hash}', 'legacy-185-20261020')`).join(',\n');
fs.writeFileSync(output, `-- Real exclusions, NOT delivery records. Source delegated decision 6982156.\nINSERT OR IGNORE INTO shipping_exclusions (order_id,reason,decision_ref,batch) VALUES\n${rows};\nSELECT count(*) AS excluded_185 FROM shipping_exclusions WHERE batch='legacy-185-20261020';\n`);
console.log(JSON.stringify({ count: ids.length, csvSha256: hash, idsSha256: crypto.createHash('sha256').update(ids.sort().join('\n')).digest('hex'), output }));
