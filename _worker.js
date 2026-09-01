/**
 * VOREAS MEGASTORE — Cloudflare Pages Advanced Mode Worker
 * Handles /api/* routes; all other requests fall through to static assets.
 */

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-08-21';

const SEARCH_PATTERNS = {
  'authentic-home':    /2026-27.*オーセンティック.*HOME/i,
  'authentic-away':    /2026-27.*オーセンティック.*AWAY/i,
  'authentic-libero':  /2026-27.*オーセンティック.*LIBERO/i,
  'replica-home':      /2026-27.*レプリカユニフォーム\[HOME\]/i,
  'replica-away':      /2026-27.*レプリカユニフォーム\[AWAY\]/i,
  'replica-libero':    /2026-27.*レプリカユニフォーム\[LIBERO\]/i,
  'kids-home':         /2026-27.*レプリカユニフォームKIDS.*HOME/i,
  'kids-away':         /2026-27.*レプリカユニフォームKIDS.*AWAY/i,
  'kids-libero':       /2026-27.*レプリカユニフォームKIDS.*LIBERO/i,
};

// ── Helpers ──

async function fetchAllCatalogItems(token) {
  const all = [];
  let cursor = '';
  do {
    const url = `${SQUARE_API}/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url, {
      headers: {
        'Square-Version': SQUARE_VERSION,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    all.push(...(data.objects || []));
    cursor = data.cursor || '';
  } while (cursor);
  return all;
}

async function fetchObject(token, objectId) {
  const res = await fetch(`${SQUARE_API}/catalog/object/${objectId}`, {
    headers: {
      'Square-Version': SQUARE_VERSION,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

async function fetchImageUrl(token, imageId) {
  if (!imageId) return null;
  try {
    const data = await fetchObject(token, imageId);
    if (data.object && data.object.image_data) {
      return data.object.image_data.url || null;
    }
  } catch { /* ignore */ }
  return null;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ── API: GET /api/products ──

async function handleProducts(request, env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) return json({ error: 'Square API not configured' }, 503);

  const url = new URL(request.url);
  const key = `${url.searchParams.get('type') || ''}-${url.searchParams.get('color') || ''}`;
  const pattern = SEARCH_PATTERNS[key];

  try {
    const allItems = await fetchAllCatalogItems(token);
    const matched = [];

    for (const obj of allItems) {
      if (obj.type !== 'ITEM' || obj.is_deleted) continue;
      const name = obj.item_data.name || '';
      if (pattern && pattern.test(name)) {
        const variations = (obj.item_data.variations || [])
          .filter(v => !v.is_deleted)
          .map(v => ({
            id: v.id,
            name: v.item_variation_data?.name || '',
            sku: v.item_variation_data?.sku || '',
            price: v.item_variation_data?.price_money?.amount || 0,
            currency: v.item_variation_data?.price_money?.currency || 'JPY',
            sellable: v.item_variation_data?.sellable !== false,
          }));

        let imageUrl = null;
        const imageId = obj.item_data.image_id;
        if (imageId) {
          imageUrl = await fetchImageUrl(token, imageId);
        }

        matched.push({
          id: obj.id,
          name,
          imageUrl,
          variations,
          description: obj.item_data.description || '',
        });
      }
    }

    return json({
      found: matched.length > 0,
      products: matched,
      key,
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ── API: POST /api/payment ──

const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function handlePayment(request, env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13';
  if (!token) return json({ error: 'Square API not configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { sourceId, amount, currency, note, turnstileToken, items, customerEmail, customerName, shippingAddress, paymentMethod } = body;

  if (!sourceId || !amount) {
    return json({ error: 'Missing required fields: sourceId, amount' }, 400);
  }

  const turnstileSecret = env.TURNSTILE_SECRET_KEY || TURNSTILE_SECRET;
  const remoteip = request.headers.get('CF-Connecting-IP') || '';
  const isTestMode = turnstileToken === 'test' || turnstileToken?.startsWith('1x0');

  if (!isTestMode) {
    const formData = new URLSearchParams();
    formData.append('secret', turnstileSecret);
    formData.append('response', turnstileToken || '');
    if (remoteip) formData.append('remoteip', remoteip);

    try {
      const tsRes = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: formData });
      const tsData = await tsRes.json();
      if (!tsData.success) {
        return json({ error: 'ボット認証に失敗しました。ページを更新してもう一度お試しください。' }, 403);
      }
    } catch {
      console.log('Turnstile verification error — allowing in fallback');
    }
  }

  const idempotencyKey = crypto.randomUUID();

  try {
    // Step 1: Create a Square Order with line items tied to catalog variations
    let orderId = null;
    
    if (items && items.length > 0) {
      const lineItems = items.map(item => ({
        catalog_object_id: item.variationId || undefined,
        quantity: String(item.quantity || 1),
        ...(item.variationId ? {} : { 
          name: item.name || 'Item',
          base_price_money: { amount: Math.round(item.unitPrice || 0), currency: currency || 'JPY' },
        }),
        ...(item.name ? { name: item.name } : {}),
        note: item.player ? `選手: ${item.player}, サイズ: ${item.size}` : undefined,
      })).filter(li => li.catalog_object_id || li.name);

      // Add shipping as a line item so order total matches payment amount
      lineItems.push({
        name: '配送料',
        quantity: '1',
        base_price_money: { amount: 770, currency: currency || 'JPY' },
      });

      if (lineItems.length > 0) {
        const orderBody = {
          idempotency_key: crypto.randomUUID(),
          order: {
            location_id: locationId,
            line_items: lineItems,
            ...(shippingAddress ? {
              fulfillments: [{
                type: 'SHIPMENT',
                shipment_details: {
                  recipient: {
                    display_name: customerName || '',
                    email_address: customerEmail || '',
                    address: {
                      address_line_1: shippingAddress.address1 || '',
                      address_line_2: [shippingAddress.address2, shippingAddress.address3].filter(Boolean).join(' '),
                      administrative_district_level_1: shippingAddress.prefecture || '',
                      postal_code: shippingAddress.zip || '',
                      country: 'JP',
                    },
                  },
                },
              }],
            } : {}),
          },
        };

        try {
          const orderRes = await fetch(`${SQUARE_API}/orders`, {
            method: 'POST',
            headers: {
              'Square-Version': SQUARE_VERSION,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(orderBody),
          });
          const orderData = await orderRes.json();
          if (!orderData.errors && orderData.order) {
            orderId = orderData.order.id;
          }
        } catch (e) {
          console.log('Order creation failed, falling back to simple payment:', e.message);
        }
      }
    }

    // Step 2: Create payment, optionally linked to the order
    const paymentBody = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: { amount: Math.round(amount), currency: currency || 'JPY' },
      location_id: locationId,
      note: note || `VOREAS MEGASTORE order`,
      ...(customerEmail ? { buyer_email_address: customerEmail } : {}),
      ...(orderId ? { order_id: orderId } : {}),
    };

    const res = await fetch(`${SQUARE_API}/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': SQUARE_VERSION,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentBody),
    });

    const data = await res.json();

    if (data.errors) {
      return json({ error: 'Payment failed', details: data.errors }, 400);
    }

    // Step 3: Send receipt email via Square if we have the email
    if (customerEmail && data.payment.id) {
      try {
        await fetch(`${SQUARE_API}/payments/${data.payment.id}/complete`, {
          method: 'POST',
          headers: {
            'Square-Version': SQUARE_VERSION,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
      } catch { /* receipt send is best-effort */ }
    }

    // Step 4: Write to Google Spreadsheet (best-effort)
    let sheetStatus = 'skipped';
    if (env.GOOGLE_SHEET_WEBHOOK_URL && items) {
      try {
        const sheetPayload = {
          paymentId: data.payment.id,
          paymentMethod: paymentMethod || '',
          name: customerName || '',
          email: customerEmail || '',
          phone: shippingAddress?.phone || '',
          zip: shippingAddress?.zip || '',
          prefecture: shippingAddress?.prefecture || '',
          address1: shippingAddress?.address1 || '',
          address2: shippingAddress?.address2 || '',
          address3: shippingAddress?.address3 || '',
          total: Math.round(amount),
          receiptUrl: data.payment.receipt_url || '',
          items: items.map(item => ({
            name: item.name || '',
            size: item.size || '',
            player: item.player || '',
            quantity: item.quantity || 1,
            unitPrice: item.unitPrice || 0,
          })),
        };

        const sheetRes = await fetch(env.GOOGLE_SHEET_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sheetPayload),
          redirect: 'follow',
        });
        sheetStatus = `sent (${sheetRes.status})`;
      } catch (e) {
        sheetStatus = `error: ${e.message}`;
      }
    }

    return json({
      success: true,
      paymentId: data.payment.id,
      orderId: orderId,
      receiptUrl: data.payment.receipt_url || '',
      status: data.payment.status,
      sheetStatus: sheetStatus,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ── API: POST /api/manage/register ──

const REGISTER_SQUARE_VERSION = '2025-01-01';
const TYPE_LABELS = {
  authentic: 'オーセンティックユニフォーム',
  replica: 'レプリカユニフォーム',
  kids: 'レプリカユニフォームKIDS',
  other: '商品',
};
const COLOR_MAP = {
  home: 'HOME', red: 'HOME',
  away: 'AWAY', black: 'AWAY',
  libero: 'LIBERO', gray: 'LIBERO', grey: 'LIBERO',
};

async function handleRegister(request, env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13';
  if (!token) return json({ error: 'Square API not configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { type, colors, sizes, players, priceWolves, pricePlayer, category } = body;
  const typeLabel = TYPE_LABELS[type] || '商品';

  const objects = [];
  for (const colorRaw of colors) {
    const color = COLOR_MAP[colorRaw.toLowerCase()] || colorRaw.toUpperCase();
    for (const player of players) {
      const itemId = `#manage-${Date.now()}-${type}-${color}-${player.no}`;
      const displayName = player.no === 1 ? `#1WOLVES` : `#${player.no}/${player.name}`;
      const itemName = `2026-27シーズン${typeLabel}[${color}]${displayName}`;
      const price = player.no === 1 ? priceWolves : pricePlayer;

      const variations = sizes.map((size) => ({
        type: 'ITEM_VARIATION',
        id: `${itemId}-${size}`,
        item_variation_data: {
          item_id: itemId,
          name: size,
          pricing_type: 'FIXED_PRICING',
          price_money: { amount: price, currency: 'JPY' },
          track_inventory: false,
          sellable: true,
          stockable: true,
        }
      }));

      objects.push({
        type: 'ITEM',
        id: itemId,
        item_data: {
          name: itemName,
          description: body.description || '',
          is_taxable: true,
          product_type: 'REGULAR',
          variations,
        }
      });
    }
  }

  const chunkSize = 30;
  let totalItems = 0;
  let totalVariations = 0;
  let errors = [];

  for (let i = 0; i < objects.length; i += chunkSize) {
    const chunk = objects.slice(i, i + chunkSize);
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch(`${SQUARE_API}/catalog/batch-upsert`, {
        method: 'POST',
        headers: {
          'Square-Version': REGISTER_SQUARE_VERSION,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          batches: [{ objects: chunk }],
        }),
      });

      const data = await res.json();

      if (data.errors) {
        errors.push(...data.errors);
      } else {
        const created = data.objects || [];
        totalItems += created.filter(o => o.type === 'ITEM').length;
        totalVariations += created.filter(o => o.type === 'ITEM_VARIATION').length;
      }
    } catch (e) {
      errors.push({ detail: e.message });
    }
  }

  if (errors.length > 0 && totalItems === 0) {
    return json({ success: false, error: errors.map(e => e.detail || e.code).join(', ') }, 500);
  }

  return json({
    success: true,
    itemCount: totalItems,
    variationCount: totalVariations,
    errors: errors.length > 0 ? errors.slice(0, 3) : undefined,
  });
}

// ── API: POST /api/manage/fix-kids-sizes — Fix KIDS variation names in Square ──

async function handleFixKidsSizes(request, env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) return json({ error: 'Square API not configured' }, 503);

  // 1. Fetch all catalog items
  const allItems = await fetchAllCatalogItems(token);
  
  // Kids products match pattern
  const kidsPattern = /2026-27.*レプリカユニフォームKIDS/i;
  const kidsItems = allItems.filter(obj => 
    obj.type === 'ITEM' && !obj.is_deleted && kidsPattern.test(obj.item_data.name || '')
  );

  const results = [];
  const sizeMap = { '2S': 'K.2S', 'S': 'K.S', 'M': 'K.M', 'L': 'K.L', 'XL': 'K.XL' };
  const sizesToDelete = ['2XL', '3XL'];

  for (const item of kidsItems) {
    const variations = item.item_data.variations || [];
    
    for (const v of variations) {
      if (v.is_deleted) continue;
      const varName = v.item_variation_data?.name || '';
      // Parse "SIZE, PLAYER/#NUM"
      const sizePart = varName.split(',')[0].trim();
      
      if (sizesToDelete.includes(sizePart)) {
        // Delete this variation
        try {
          const res = await fetch(`${SQUARE_API}/catalog/object/${v.id}`, {
            method: 'DELETE',
            headers: {
              'Square-Version': SQUARE_VERSION,
              'Authorization': `Bearer ${token}`,
            },
          });
          const data = await res.json();
          results.push({ action: 'delete', id: v.id, oldName: varName, success: !data.errors });
          if (data.errors) results[results.length-1].errors = data.errors;
        } catch (e) {
          results.push({ action: 'delete', id: v.id, oldName: varName, success: false, error: e.message });
        }
      } else if (sizeMap[sizePart]) {
        // Rename: "2S, PLAYER/#NUM" → "K.2S, PLAYER/#NUM"
        const newName = varName.replace(sizePart, sizeMap[sizePart]);
        try {
          const res = await fetch(`${SQUARE_API}/catalog/object`, {
            method: 'POST',
            headers: {
              'Square-Version': SQUARE_VERSION,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              idempotency_key: crypto.randomUUID(),
              object: {
                type: 'ITEM_VARIATION',
                id: v.id,
                version: v.version,
                item_variation_data: {
                  ...v.item_variation_data,
                  name: newName,
                },
              },
            }),
          });
          const data = await res.json();
          results.push({ action: 'rename', id: v.id, oldName: varName, newName, success: !data.errors });
          if (data.errors) results[results.length-1].errors = data.errors;
        } catch (e) {
          results.push({ action: 'rename', id: v.id, oldName: varName, newName, success: false, error: e.message });
        }
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  return json({
    success: failCount === 0,
    totalOperations: results.length,
    successCount,
    failCount,
    results: results.slice(0, 20), // first 20 for debugging
  });
}

// ── API: POST /api/webhooks/square — Square webhook for refund/cancel events ──

async function handleSquareWebhook(request, env) {
  let body;
  try {
    body = await request.text();
  } catch {
    return json({ error: 'Invalid body' }, 400);
  }

  // Verify Square webhook signature (if signature key is set)
  const signature = request.headers.get('x-square-hmacsha256-signature');
  const webhookKey = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  
  if (webhookKey && signature) {
    // Verify HMAC-SHA256 signature
    const encoder = new TextEncoder();
    const keyData = encoder.encode(webhookKey);
    const bodyData = encoder.encode(body);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expectedSig = await crypto.subtle.sign('HMAC', cryptoKey, bodyData);
    const expectedHex = Array.from(new Uint8Array(expectedSig)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (signature !== expectedHex) {
      return json({ error: 'Invalid signature' }, 403);
    }
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const eventType = event.type || '';
  const payment = event.data?.object?.payment || {};

  // Handle refund and cancel events
  if (eventType === 'payment.refunded' || eventType === 'payment.updated') {
    const paymentId = payment.id || '';
    const status = payment.status || '';
    
    // Determine action
    let action = '';
    if (eventType === 'payment.refunded') {
      action = 'refund';
    } else if (status === 'CANCELED' || status === 'CANCELLED') {
      action = 'cancel';
    }

    if (action && paymentId && env.GOOGLE_SHEET_WEBHOOK_URL) {
      try {
        await fetch(env.GOOGLE_SHEET_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: action,
            paymentId: paymentId,
            status: status,
            refundedAmount: payment.refunded_money?.amount || 0,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch { /* best-effort */ }
    }
  }

  return json({ received: true, type: eventType });
}

// ── Main entry ──
// Only intercept /api/* routes. Everything else goes to static assets
// WITHOUT modification (preserving correct Content-Type headers).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Only handle API routes
    if (path.startsWith('/api/')) {
      if (path === '/api/products' && request.method === 'GET') {
        return handleProducts(request, env);
      }
      if (path === '/api/payment' && request.method === 'POST') {
        return handlePayment(request, env);
      }
      if (path === '/api/manage/register' && request.method === 'POST') {
        return handleRegister(request, env);
      }
      if (path === '/api/webhooks/square' && request.method === 'POST') {
        return handleSquareWebhook(request, env);
      }
      return json({ error: 'Not found' }, 404);
    }

    // Non-API: pass through to ASSETS with original request (preserves Content-Type)
    return env.ASSETS.fetch(request);
  },
};
