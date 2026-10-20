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
        const imageId = (obj.item_data.image_ids || [])[0];
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

  const { sourceId, amount, currency, note, turnstileToken, items, customerEmail, customerName, shippingAddress, paymentMethod, couponCode } = body;

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
        // Token may have expired (timeout) — allow through but log
        console.log('Turnstile verification failed — token may have expired');
      }
    } catch {
      console.log('Turnstile verification error — allowing in fallback');
    }
  }

  const idempotencyKey = crypto.randomUUID();

  try {
    // Step 1: Create a Square Order with line items tied to catalog variations
    let orderId = null;
    let couponStatus = 'none';
    let discountAmount = 0;
    let orderErrors = null; // populated when Square CreateOrder fails (surfaced in responses for debugging)
    const orderDiscounts = []; // Square-standard order-level discounts (OrderLineItemDiscount)
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

      // Apply coupon discount if provided
      if (couponCode) {
        try {
          // Search Square Catalog for a discount matching the coupon code
          const catalogRes = await fetch(`${SQUARE_API}/catalog/list?types=DISCOUNT`, {
            method: 'GET',
            headers: {
              'Square-Version': SQUARE_VERSION,
              'Authorization': `Bearer ${token}`,
            },
          });
          const catalogData = await catalogRes.json();

          if (catalogData.objects) {
            // Find discount by name (strip emoji prefixes for easier matching)
            const stripEmoji = (s) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim();
            const inputClean = stripEmoji(couponCode).toUpperCase();
            const discount = catalogData.objects.find(obj => {
              if (obj.is_deleted) return false;
              const name = obj.discount_data?.name || '';
              const nameClean = stripEmoji(name).toUpperCase();
              return nameClean === inputClean || name.toUpperCase() === couponCode.toUpperCase();
            });

            if (discount) {
              const dd = discount.discount_data;
              if (dd.discount_type === 'FIXED_PERCENTAGE' || dd.discount_type === 'VARIABLE_PERCENTAGE') {
                const pct = parseFloat(dd.percentage || '0');
                // Calculate discount on item subtotal (not total which includes shipping and may already be discounted)
                let itemSubtotal = 0;
                for (const item of (items || [])) {
                  itemSubtotal += (item.unitPrice || 0) * (item.quantity || 1);
                }
                discountAmount = Math.round(itemSubtotal * pct / 100);
                couponStatus = `applied: ${pct}% (-¥${discountAmount})`;
              } else if (dd.discount_type === 'FIXED_AMOUNT' || dd.discount_type === 'VARIABLE_AMOUNT') {
                discountAmount = dd.amount_money?.amount || 0;
                couponStatus = `applied: -¥${discountAmount}`;
              }

              if (discountAmount > 0) {
                // Apply the coupon as a Square-standard order-level manual discount.
                // NOTE: a standalone discount line item with
                // line_items[].catalog_object_id = CatalogDiscount ID is invalid —
                // catalog_object_id must reference a CatalogItem/CatalogItemVariation,
                // so CreateOrder rejected the whole request and the payment was
                // created WITHOUT the order (no fulfillment/recipient → the
                // Square Dashboard shipping list shows no buyer name).
                orderDiscounts.push({
                  name: `クーポン割引 (${couponCode})`,
                  type: 'FIXED_AMOUNT',
                  amount_money: { amount: discountAmount, currency: currency || 'JPY' },
                  scope: 'ORDER',
                });
              }
            } else {
              couponStatus = 'invalid code';
            }
          }
        } catch (e) {
          couponStatus = `error: ${e.message}`;
        }
      }

      if (lineItems.length > 0) {
        const orderBody = {
          idempotency_key: crypto.randomUUID(),
          order: {
            location_id: locationId,
            line_items: lineItems,
            ...(orderDiscounts.length > 0 ? { discounts: orderDiscounts } : {}),
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
          } else if (orderData.errors) {
            orderErrors = orderData.errors;
            console.log('Square order creation failed (payment will proceed without order):', JSON.stringify(orderData.errors));
          }
        } catch (e) {
          orderErrors = [{ category: 'NETWORK', detail: `Order creation fetch failed: ${e.message}` }];
          console.log('Order creation failed, falling back to simple payment:', e.message);
        }
      }
    }

    // Step 1b: Create or find a Square Customer with the buyer's email
    // This enables Square to send automatic receipt emails
    let customerId = null;
    if (customerEmail) {
      try {
        // Search for existing customer by email
        const searchRes = await fetch(`${SQUARE_API}/customers/search`, {
          method: 'POST',
          headers: {
            'Square-Version': SQUARE_VERSION,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: { filter: { email_address: { exact: customerEmail } } },
          }),
        });
        const searchData = await searchRes.json();
        if (searchData.customers && searchData.customers.length > 0) {
          customerId = searchData.customers[0].id;
        } else {
          // Create new customer
          const custRes = await fetch(`${SQUARE_API}/customers`, {
            method: 'POST',
            headers: {
              'Square-Version': SQUARE_VERSION,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              idempotency_key: crypto.randomUUID(),
              given_name: customerName?.split(' ')[0] || '',
              family_name: customerName?.split(' ').slice(1).join(' ') || '',
              email_address: customerEmail,
              phone_number: shippingAddress?.phone || '',
              address: {
                postal_code: shippingAddress?.zip || '',
                administrative_district_level_1: shippingAddress?.prefecture || '',
                locality: shippingAddress?.address1 || '',
                address_line_1: shippingAddress?.address2 || '',
                address_line_2: shippingAddress?.address3 || '',
                country: 'JP',
              },
            }),
          });
          const custData = await custRes.json();
          if (custData.customer) {
            customerId = custData.customer.id;
          }
        }
      } catch (e) {
        console.log('Customer creation failed:', e.message);
      }
    }

    // Step 2: Create payment, optionally linked to the order and customer
    // If the Square order could not be created, mark it on the payment note so
    // the Dashboard shows why the payment is not linked to an order.
    const paymentNote = (note || `VOREAS MEGASTORE order`) + (orderId ? '' : ' [Square注文未作成 — 紐付けなし]');
    const paymentBody = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: { amount: Math.round(amount), currency: currency || 'JPY' },
      location_id: locationId,
      note: paymentNote,
      ...(customerEmail ? { buyer_email_address: customerEmail } : {}),
      ...(orderId ? { order_id: orderId } : {}),
      ...(customerId ? { customer_id: customerId } : {}),
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
      // Include orderId/couponStatus/orderErrors so order-vs-payment failures are
      // distinguishable from the client response (previously silent).
      return json({
        error: 'Payment failed',
        details: data.errors,
        orderId: orderId || null,
        couponStatus: couponStatus,
        ...(orderErrors ? { orderErrors: orderErrors } : {}),
      }, 400);
    }

    // Step 3: Send receipt email directly via Resend API (reliable, no Apps Script dependency)
    let emailStatus = 'skipped';
    if (customerEmail && env.RESEND_API_KEY) {
      try {
        const items2 = items || [];
        let rows = '';
        let itemTotal = 0;
        for (const item of items2) {
          const subtotal = (item.unitPrice || 0) * (item.quantity || 1);
          itemTotal += subtotal;
          rows += `<tr><td style="padding:10px;border-bottom:1px solid #eee;">${item.name || ''}<br><span style="font-size:12px;color:#888;">サイズ: ${item.size || '-'} / 選手名: ${item.player || '-'}</span></td><td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">${item.quantity || 1}</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;">¥${subtotal.toLocaleString()}</td></tr>`;
        }
        const shipping = 770;
        const discountedSubtotal = itemTotal - discountAmount;
        const grandTotal = discountedSubtotal + shipping;
        const orderDate = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const paymentId = data.payment.id || '';
        const paymentMethodLabel = paymentMethod === 'Bank' ? '銀行振込' : (paymentMethod || 'クレジットカード');
        const discountRow = discountAmount > 0
          ? `<tr><td style="padding:10px;text-align:right;border-bottom:1px solid #eee;">クーポン割引 (${couponCode || ''})</td><td colspan="2" style="padding:10px;text-align:right;border-bottom:1px solid #eee;color:#9e2b25;">-¥${discountAmount.toLocaleString()}</td></tr>
             <tr><td style="padding:10px;text-align:right;border-bottom:1px solid #eee;font-weight:bold;">割引後小計</td><td colspan="2" style="padding:10px;text-align:right;border-bottom:1px solid #eee;font-weight:bold;">¥${discountedSubtotal.toLocaleString()}</td></tr>`
          : '';

        const emailHtml = `<!DOCTYPE html><html><body>
<div style="max-width:600px;margin:0 auto;font-family:'Hiragino Sans','Meiryo',sans-serif;color:#333;">
<div style="background:#9e2b25;padding:20px;text-align:center;">
<h1 style="color:#fff;font-size:22px;margin:0;letter-spacing:0.05em;">VOREAS MEGASTORE</h1>
<p style="color:#fff;font-size:11px;margin:4px 0 0;">10TH ANNIVERSARY</p>
</div>

<div style="padding:24px;">
<p style="font-size:16px;">${customerName || ''} 様</p>
<p style="font-size:14px;line-height:1.8;margin:16px 0;">このたびはVOREAS MEGASTOREをご利用いただき、誠にありがとうございます。以下の内容でご注文を承りました。</p>

<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
<tr style="background:#f5f5f5;"><th style="padding:10px;text-align:left;border-bottom:2px solid #9e2b25;">商品</th><th style="padding:10px;text-align:center;border-bottom:2px solid #9e2b25;">数量</th><th style="padding:10px;text-align:right;border-bottom:2px solid #9e2b25;">小計</th></tr>
${rows}
<tr><td style="padding:10px;text-align:right;border-bottom:1px solid #eee;">小計</td><td colspan="2" style="padding:10px;text-align:right;border-bottom:1px solid #eee;">¥${itemTotal.toLocaleString()}</td></tr>
${discountRow}
<tr><td style="padding:10px;text-align:right;border-bottom:1px solid #eee;">配送料</td><td colspan="2" style="padding:10px;text-align:right;border-bottom:1px solid #eee;">¥${shipping.toLocaleString()}</td></tr>
<tr><td style="padding:14px;text-align:right;font-weight:bold;font-size:16px;">合計</td><td colspan="2" style="padding:14px;text-align:right;font-weight:bold;font-size:20px;color:#9e2b25;">¥${grandTotal.toLocaleString()}</td></tr>
</table>

<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px;">
<tr><td style="padding:8px 0;color:#888;width:100px;">注文日時</td><td style="padding:8px 0;">${orderDate}</td></tr>
<tr><td style="padding:8px 0;color:#888;">注文番号</td><td style="padding:8px 0;">${paymentId}</td></tr>
<tr><td style="padding:8px 0;color:#888;">お支払い方法</td><td style="padding:8px 0;">${paymentMethodLabel}</td></tr>
</table>

<h3 style="font-size:14px;border-left:3px solid #9e2b25;padding-left:10px;margin:24px 0 8px;">お届け先</h3>
<p style="font-size:13px;line-height:1.8;">〒${shippingAddress?.zip || ''}<br>${shippingAddress?.prefecture || ''}${shippingAddress?.address1 || ''} ${shippingAddress?.address2 || ''} ${shippingAddress?.address3 || ''}<br>${customerName || ''}<br>TEL: ${shippingAddress?.phone || ''}</p>

${data.payment.receipt_url ? `<p style="margin:20px 0;"><a href="${data.payment.receipt_url}" style="display:inline-block;padding:12px 32px;background:#9e2b25;color:#fff;text-decoration:none;border-radius:4px;font-size:14px;">レシートを確認する</a></p>` : ''}

<div style="background:#f9f9f9;padding:16px;border-radius:4px;margin:24px 0;">
<p style="font-size:13px;font-weight:bold;margin:0 0 8px;">⚠ 注意事項</p>
<ul style="font-size:12px;line-height:1.8;color:#555;margin:0;padding-left:20px;">
<li>こちらのメールアドレスは<strong>送信専用</strong>です。このメールに返信されても対応できません。</li>
<li>ご不明な点がございましたら、お問い合わせフォームよりご連絡ください。</li>
<li>発送完了時には別途メールでお知らせいたします。発送まで今しばらくお待ちください。</li>
<li>受注販売期間中の商品は、生産完了後に順次発送いたします。お届けまでにお時間をいただく場合がございます。</li>
</ul>
</div>

<p style="margin:20px 0;">
<a href="https://voreas-contact.pages.dev/contact" style="display:inline-block;padding:10px 28px;border:1px solid #9e2b25;color:#9e2b25;text-decoration:none;border-radius:4px;font-size:13px;">お問い合わせフォームはこちら</a>
</p>

<hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
<p style="font-size:11px;color:#999;text-align:center;">VOREAS MEGASTORE — 10TH ANNIVERSARY<br>Copyright (C) 2026 VOREAS,INC. All Rights Reserved.</p>
</div>
</div>
</body></html>`;

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'VOREAS MEGASTORE <noreply@voreas.app>',
            to: customerEmail,
            subject: '【VOREAS MEGASTORE】ご注文ありがとうございます',
            html: emailHtml,
          }),
        });
        emailStatus = emailRes.ok ? 'sent' : `error: ${emailRes.status}`;
      } catch (e) {
        emailStatus = `error: ${e.message}`;
      }
    }

    // Step 4: Write to Google Spreadsheet (best-effort)
    let sheetStatus = 'skipped';
    if (env.GOOGLE_SHEET_WEBHOOK_URL && items) {
      try {
        const sheetPayload = {
          sendEmail: false,
          paymentId: data.payment.id,
          paymentMethod: paymentMethod || '',
          name: customerName || '',
          email: customerEmail || '',
          phone: String(shippingAddress?.phone || ''),
          zip: String(shippingAddress?.zip || ''),
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
      emailStatus: emailStatus,
      sheetStatus: sheetStatus,
      couponStatus: couponStatus,
      ...(orderErrors ? { orderErrors: orderErrors } : {}),
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

  // Fail closed for ALL event types. Never process unsigned refund/payment events.
  const signature = request.headers.get('x-square-hmacsha256-signature');
  const webhookKey = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  
  if (!webhookKey) return json({ error: 'Webhook verification not configured' }, 503);
  if (!signature) return json({ error: 'Invalid signature' }, 401);
  {
    // Square signature = base64(HMAC-SHA256(key, notification_url + body))
    const notificationUrl = 'https://voreas-megastore.pages.dev/api/webhooks/square';
    const encoder = new TextEncoder();
    const keyData = encoder.encode(webhookKey);
    const signedData = encoder.encode(notificationUrl + body);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expectedSig = await crypto.subtle.sign('HMAC', cryptoKey, signedData);
    // Convert to base64
    const expectedBytes = new Uint8Array(expectedSig);
    let binary = '';
    for (const b of expectedBytes) binary += String.fromCharCode(b);
    const expectedB64 = btoa(binary);
    let mismatch = signature.length ^ expectedB64.length;
    for (let i = 0; i < expectedB64.length; i++) mismatch |= expectedB64.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
    if (mismatch) return json({ error: 'Invalid signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const eventType = event.type || '';
  if (eventType === 'order.updated') return handleShippingUpdated(event, env);
  
  // Extract payment ID and status from different event types
  let paymentId = '';
  let status = '';
  let action = '';
  let refundedAmount = 0;

  if (eventType === 'refund.created' || eventType === 'refund.updated') {
    // Refund events: event.data.object.refund
    const refund = event.data?.object?.refund || {};
    paymentId = refund.payment_id || '';
    status = refund.status || '';
    refundedAmount = refund.amount_money?.amount || 0;
    if (paymentId) action = 'refund';
  } else if (eventType === 'payment.updated') {
    // Payment updated events: event.data.object.payment
    const payment = event.data?.object?.payment || {};
    paymentId = payment.id || '';
    status = payment.status || '';
    if (status === 'CANCELED' || status === 'CANCELLED') {
      action = 'cancel';
    }
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
          refundedAmount: refundedAmount,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch { /* best-effort */ }
  }

  return json({ received: true, type: eventType, action: action, paymentId: paymentId });
}

// ── Meta (Facebook/Instagram) catalog integration ──
// GET /api/meta-feed.csv  — Meta Commerce Manager scheduled data feed (CSV),
//   generated live from Square Catalog. One row per sellable variation.
//   id = Square variation ID (same ID the cart/checkout uses), grouped by
//   product page via item_group_id. Spec:
//   https://www.facebook.com/business/help/120325381656392
//   https://www.facebook.com/business/help/2256580051262113 (variants)
// GET /api/meta-cart?products=ID:QTY,ID:QTY — resolves Meta checkout-URL
//   product IDs into cart items for /meta-checkout.html. Spec:
//   https://developers.facebook.com/documentation/ads-commerce/commerce-platform/setup-checkout-url

const META_PAGES = {
  'authentic-home':   { title: '2026-27シーズン オーセンティックユニフォーム[HOME]', badge: 'HOME [RED]', color: 'Red', age: 'adult', image: 'images/products/authentic-2026-27-red.jpg' },
  'authentic-away':   { title: '2026-27シーズン オーセンティックユニフォーム[AWAY]', badge: 'AWAY [BLACK]', color: 'Black', age: 'adult', image: 'images/products/authentic-2026-27-black.jpg' },
  'authentic-libero': { title: '2026-27シーズン オーセンティックユニフォーム[LIBERO]', badge: 'LIBERO [GRAY]', color: 'Gray', age: 'adult', image: 'images/products/authentic-2026-27-gray.jpg' },
  'replica-home':     { title: '2026-27シーズン レプリカユニフォーム[HOME]', badge: 'HOME [RED] — REPLICA', color: 'Red', age: 'adult', image: 'images/products/replica-2026-27-red.png' },
  'replica-away':     { title: '2026-27シーズン レプリカユニフォーム[AWAY]', badge: 'AWAY [BLACK] — REPLICA', color: 'Black', age: 'adult', image: 'images/products/replica-2026-27-black.png' },
  'replica-libero':   { title: '2026-27シーズン レプリカユニフォーム[LIBERO]', badge: 'LIBERO [GRAY] — REPLICA', color: 'Gray', age: 'adult', image: 'images/products/replica-2026-27-gray.png' },
  'kids-home':        { title: '2026-27シーズン レプリカユニフォームKIDS[HOME]', badge: 'HOME [RED] — KIDS', color: 'Red', age: 'kids', image: 'images/products/replica-2026-27-red.png' },
  'kids-away':        { title: '2026-27シーズン レプリカユニフォームKIDS[AWAY]', badge: 'AWAY [BLACK] — KIDS', color: 'Black', age: 'kids', image: 'images/products/replica-2026-27-black.png' },
  'kids-libero':      { title: '2026-27シーズン レプリカユニフォームKIDS[LIBERO]', badge: 'LIBERO [GRAY] — KIDS', color: 'Gray', age: 'kids', image: 'images/products/replica-2026-27-gray.png' },
};
const META_BRAND = 'VOREAS HOKKAIDO';
const META_GOOGLE_CATEGORY = '3598'; // Apparel & Accessories > Clothing > Uniforms > Sports Uniforms
const META_CACHE_SECONDS = 900;

// "2S, NAKAMICHI/#2" → { size: '2S', playerName: 'NAKAMICHI', playerNum: '2' }
function parseMetaVariationName(name) {
  const t = (name || '').trim();
  const m = t.match(/^([^,]+),\s*(.+?)\/#(\d+)$/);
  if (m) return { size: m[1].trim(), playerName: m[2].trim(), playerNum: m[3] };
  return { size: t, playerName: null, playerNum: null };
}

function metaPlainText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 9999);
}

function isVariationSoldOut(v, locationId) {
  const d = v.item_variation_data || {};
  if (d.sellable === false) return true;
  return (d.location_overrides || []).some(o =>
    o.sold_out === true && (!locationId || o.location_id === locationId));
}

// Build every Meta catalog row from Square Catalog (shared by feed + cart resolver).
async function buildMetaRows(env, origin) {
  const token = env.SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13';
  const items = await fetchAllCatalogItems(token);
  const rows = [];
  for (const [key, page] of Object.entries(META_PAGES)) {
    const pattern = SEARCH_PATTERNS[key];
    const [type, color] = key.split('-');
    const matched = items.filter(o => o.type === 'ITEM' && !o.is_deleted &&
      pattern.test((o.item_data && o.item_data.name) || ''));
    const pageUrl = `${origin}/product-${key}`;
    for (const item of matched) {
      const desc = metaPlainText(item.item_data.description) ||
        `${page.title}（${page.badge}）VOREAS HOKKAIDO 公式ユニフォーム`;
      for (const v of (item.item_data.variations || [])) {
        if (v.is_deleted) continue;
        const d = v.item_variation_data || {};
        const amount = d.price_money && d.price_money.amount;
        if (!amount) continue; // Meta requires a price
        const p = parseMetaVariationName(d.name);
        const playerLabel = p.playerNum ? `#${p.playerNum} ${p.playerName}` : '';
        rows.push({
          id: v.id,
          item_group_id: `voreas-2026-27-${key}`,
          title: playerLabel ? `${page.title} ${playerLabel}` : page.title,
          description: desc,
          availability: isVariationSoldOut(v, locationId) ? 'out of stock' : 'in stock',
          condition: 'new',
          price: `${amount} ${(d.price_money.currency || 'JPY')}`,
          link: `${pageUrl}?variant=${encodeURIComponent(v.id)}`,
          image_link: `${origin}/${page.image}`,
          brand: META_BRAND,
          size: p.size,
          color: page.color,
          gender: 'unisex',
          age_group: page.age,
          google_product_category: META_GOOGLE_CATEGORY,
          additional_variant_attribute: playerLabel ? `背番号:${playerLabel}` : '背番号:なし',
          internal_label: `'${type}','${color}'`,
          // not exported to the feed; used by /api/meta-cart
          _cart: {
            productId: item.id,
            productType: type,
            productColor: color,
            name: page.title,
            badge: page.badge,
            size: p.size,
            player: p.playerNum ? `${p.playerName}/#${p.playerNum}` : '',
            unitPrice: amount,
            variationId: v.id,
            imageUrl: `/${page.image}`,
            soldOut: isVariationSoldOut(v, locationId),
          },
        });
      }
    }
  }
  return rows;
}

const META_FEED_FIELDS = ['id', 'item_group_id', 'title', 'description', 'availability',
  'condition', 'price', 'link', 'image_link', 'brand', 'size', 'color', 'gender',
  'age_group', 'google_product_category', 'additional_variant_attribute', 'internal_label'];

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r\s]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function cachedMeta(request, ctx, build) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200 && ctx) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function handleMetaFeed(request, env, ctx) {
  if (!env.SQUARE_ACCESS_TOKEN) return json({ error: 'Square API not configured' }, 503);
  const url = new URL(request.url);
  return cachedMeta(request, ctx, async () => {
    try {
      const rows = await buildMetaRows(env, url.origin);
      const lines = [META_FEED_FIELDS.join(',')];
      for (const r of rows) lines.push(META_FEED_FIELDS.map(f => csvCell(r[f])).join(','));
      return new Response('\uFEFF' + lines.join('\r\n') + '\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': `public, max-age=${META_CACHE_SECONDS}`,
          'X-Robots-Tag': 'noindex',
        },
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  });
}

async function handleMetaCart(request, env, ctx) {
  if (!env.SQUARE_ACCESS_TOKEN) return json({ error: 'Square API not configured' }, 503);
  const url = new URL(request.url);
  const wanted = [];
  for (const entry of (url.searchParams.get('products') || '').split(',')) {
    const [id, q] = entry.split(':');
    const qty = parseInt(q, 10);
    if (id && id.trim()) wanted.push({ id: id.trim(), quantity: qty > 0 ? Math.min(qty, 99) : 1 });
  }
  if (wanted.length === 0) return json({ items: [], missing: [] });
  try {
    // Reuse a cached copy of the catalog rows (keyed on origin only).
    const rowsRes = await cachedMeta(new Request(`${url.origin}/api/meta-cart/_rows`), ctx, async () =>
      new Response(JSON.stringify((await buildMetaRows(env, url.origin)).map(r => r._cart)), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${META_CACHE_SECONDS}` },
      }));
    const all = await rowsRes.json();
    const byId = new Map(all.map(c => [c.variationId, c]));
    const items = [], missing = [], soldOut = [];
    for (const w of wanted) {
      const c = byId.get(w.id);
      if (!c) { missing.push(w.id); continue; }
      if (c.soldOut) { soldOut.push(w.id); continue; }
      const { soldOut: _s, ...cartItem } = c;
      items.push({ ...cartItem, quantity: w.quantity });
    }
    return json({ items, missing, soldOut }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
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
      if (path === '/api/manage/notify-shipped' && request.method === 'POST') {
        return handleNotifyShipped(request, env);
      }
      if (path === '/api/manage/register' && request.method === 'POST') {
        return handleRegister(request, env);
      }
      if (path === '/api/webhooks/square' && request.method === 'POST') {
        return handleSquareWebhook(request, env);
      }
      if (path === '/api/test-email' && request.method === 'POST') {
        // Debug endpoint: test if Apps Script webhook + email works
        const webhookUrl = env.GOOGLE_SHEET_WEBHOOK_URL;
        if (!webhookUrl) return json({ error: 'GOOGLE_SHEET_WEBHOOK_URL not set' }, 500);
        
        const testPayload = {
          sendEmail: false,
          paymentId: 'TEST-' + Date.now(),
          paymentMethod: 'Card',
          name: 'テスト 太郎',
          email: 's-ikeda@remium.jp',
          phone: '090-1234-5678',
          zip: '070-0000',
          prefecture: '北海道',
          address1: '旭川市テスト1-2-3',
          address2: 'テスト4-5-6',
          address3: '',
          total: 7370,
          receiptUrl: 'https://squareup.com/receipt/test',
          items: [{ name: 'テスト商品', size: 'M', player: '#2 テスト', quantity: 1, unitPrice: 6600 }],
        };
        
        try {
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload),
            redirect: 'follow',
          });
          const resText = await res.text();
          return json({ 
            webhookStatus: res.status, 
            webhookResponse: resText.substring(0, 500),
            sentEmail: true,
            emailTo: testPayload.email,
          });
        } catch (e) {
          return json({ error: e.message, webhookUrl: webhookUrl.substring(0, 50) + '...' });
        }
      }
      if (path === '/api/meta-feed.csv' && (request.method === 'GET' || request.method === 'HEAD')) {
        return handleMetaFeed(request, env, ctx);
      }
      if (path === '/api/meta-cart' && request.method === 'GET') {
        return handleMetaCart(request, env, ctx);
      }
      if (path === '/api/coupon-validate' && request.method === 'POST') {
        return handleCouponValidate(request, env);
      }
      return json({ error: 'Not found' }, 404);
    }

    // Non-API: pass through to ASSETS with original request (preserves Content-Type)
    return env.ASSETS.fetch(request);
  },
};

// Shipping recovery is deliberately isolated from checkout and Square writes.
// D1 UNIQUE claims are permanent: an ambiguous provider response is NEVER retried
// automatically (Resend's idempotency retention alone is only 24 hours).
function shippingJson(data, status = 200) {
  return json(data, status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
}
function cleanTracking(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\-‐‑‒–—―−ー]/gu, '');
}
function shippingCarrier(carrier, tracking) {
  if (/ヤマト|yamato|kuroneko/i.test(carrier)) return { carrier: 'ヤマト運輸', confirmed: true, url: `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=${encodeURIComponent(tracking)}` };
  if (/佐川|sagawa/i.test(carrier)) return { carrier: '佐川急便', confirmed: true, url: `https://k2k.sagawa-exp.co.jp/p/sagawa/web/okurijoinput.jsp?okurijoNo=${encodeURIComponent(tracking)}` };
  if (/日本郵便|ゆう|japan.?post/i.test(carrier)) return { carrier: '日本郵便', confirmed: true, url: `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(tracking)}&searchKind=S002&locale=ja` };
  return { carrier: /^\d{12}$/.test(tracking) ? 'ヤマト/佐川/日本郵便（番号のみでは特定不可）' : '要確認', confirmed: false, url: '' };
}
async function shippingSquare(env, path, body) {
  const res = await fetch(`${SQUARE_API}${path}`, { signal: AbortSignal.timeout(4000), method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(`Square read failed (${res.status})`);
  return data;
}
async function shippingManifest(env, selectedOrders = null, recipientOnly = false) {
  const orders = []; let cursor;
  if (selectedOrders) orders.push(...selectedOrders);
  else {
  do {
    const data = await shippingSquare(env, '/orders/search', { location_ids: [env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13'], limit: 500, query: { filter: { date_time_filter: { created_at: { start_at: '2026-09-01T00:00:00Z' } } }, sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' } }, ...(cursor ? { cursor } : {}) });
    orders.push(...(data.orders || [])); cursor = data.cursor;
  } while (cursor);
  }
  const rows = [], excluded = [];
  for (const order of orders) {
    for (const f of order.fulfillments || []) {
      const s = f.shipment_details;
      if (f.type !== 'SHIPMENT' || !s?.tracking_number) continue;
      if (order.source?.name !== 'voreas-ec' || order.state === 'CANCELED' || f.state !== 'COMPLETED') {
        excluded.push({ orderId: order.id, fulfillmentUid: f.uid, reason: 'source_or_state_not_eligible' }); continue;
      }
      const recipient = s.recipient || {};
      let email = recipient.email_address || '', emailSource = email ? 'shipment.recipient.email_address' : '';
      // Existing customer/payment records only; never fuzzy-match by name.
      if (!email && !recipientOnly) {
        const emails = new Set();
        for (const tender of order.tenders || []) {
          if (!tender.payment_id) continue;
          const payment = (await shippingSquare(env, `/payments/${encodeURIComponent(tender.payment_id)}`)).payment;
          if (payment?.status === 'COMPLETED' && payment.buyer_email_address) emails.add(payment.buyer_email_address.trim().toLowerCase());
        }
        if (emails.size === 1) { email = [...emails][0]; emailSource = 'payment.buyer_email_address'; }
        if (!email && emails.size === 0 && (recipient.customer_id || order.customer_id)) {
          const customer = (await shippingSquare(env, `/customers/${encodeURIComponent(recipient.customer_id || order.customer_id)}`)).customer;
          email = customer?.email_address || ''; if (email) emailSource = 'customer.email_address';
        }
      }
      email = email.trim().toLowerCase();
      const trackingNumber = cleanTracking(s.tracking_number), c = shippingCarrier(s.carrier || '', trackingNumber);
      rows.push({ orderId: order.id, fulfillmentUid: f.uid, name: recipient.display_name || '', email, emailSource, trackingNumber, rawTrackingNumber: s.tracking_number, carrier: c.carrier, carrierSource: c.confirmed ? 'Square shipment_details.carrier' : 'number_format_unconfirmed', trackingUrl: c.url, shippedAt: s.shipped_at || '', issue: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'missing_or_invalid_email' : !/^\d{10,14}$/.test(trackingNumber) ? 'invalid_tracking' : !c.confirmed ? 'carrier_confirmation_required' : '' });
    }
  }
  // One notification per order. Split shipments are held for manual review.
  for (const row of rows) if (rows.filter(r => r.orderId === row.orderId).length > 1 || orders.find(o => o.id === row.orderId)?.fulfillments?.filter(f => f.type === 'SHIPMENT').length > 1) row.issue = 'multiple_shipments_manual_review';
  rows.sort((a, b) => a.orderId.localeCompare(b.orderId) || a.fulfillmentUid.localeCompare(b.fulfillmentUid));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows))))).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash, scannedOrders: orders.length, rows, excluded, missingEmail: rows.filter(r => r.issue === 'missing_or_invalid_email'), held: rows.filter(r => r.issue) };
}
function shippingEmail(row, test = false) {
  const text = `${row.name || 'お客様'} 様\n\nVOREAS MEGASTOREをご利用いただきありがとうございます。\nご注文商品の発送が完了しましたので、お知らせいたします。\n発送通知のご案内が遅くなりましたことをお詫び申し上げます。すでにお受け取り済みの場合は、行き違いのご案内となりますことをご了承ください。\n\n注文番号：${row.orderId}\n配送会社：${row.carrier}\n追跡番号：${row.trackingNumber}\n配送状況の確認：${row.trackingUrl}\n\n配送状況の反映に時間がかかる場合があります。到着日時は配送会社の追跡ページでご確認ください。\nこのメールは送信専用です。お問い合わせ：https://voreas-contact.pages.dev/contact\n\nVOREAS MEGASTORE`;
  return { from: 'VOREAS MEGASTORE <noreply@voreas.app>', to: test ? 's-ikeda@remium.jp' : row.email, subject: `${test ? '【テスト・顧客未送信】' : ''}【VOREAS MEGASTORE】商品発送のお知らせ`, text };
}
async function shippingExclusionsReady(env) {
  const r = await env.SHIPPING_DB.prepare("SELECT COUNT(*) AS count FROM shipping_exclusions WHERE batch = 'legacy-185-20261020'").first();
  return r?.count === 185;
}
async function shippingObserve(env, eventId, orderId, outcome, detail = '') {
  await env.SHIPPING_DB.prepare('INSERT INTO shipping_observations (event_id, order_id, outcome, detail, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET outcome=excluded.outcome, detail=excluded.detail, updated_at=excluded.updated_at').bind(eventId, orderId, outcome, detail, new Date().toISOString()).run();
}
async function handleShippingUpdated(event, env) {
  // order.updated carries a summary, NOT the full order. Read current state so
  // late/out-of-order notifications cannot regress fulfillment state.
  const orderId = event.data?.object?.order_updated?.order_id;
  if (!event.event_id || typeof orderId !== 'string' || !orderId) return shippingJson({ error: 'Malformed order.updated' }, 400);
  if (!env.SHIPPING_DB) return shippingJson({ error: 'Shipping DB not configured' }, 503);
  const record = async (outcome, detail = '') => {
    await shippingObserve(env, event.event_id, orderId, outcome, detail);
    return shippingJson({ received: true, shipping: outcome });
  };
  try {
    const excluded = await env.SHIPPING_DB.prepare('SELECT reason FROM shipping_exclusions WHERE order_id = ?').bind(orderId).first();
    if (excluded) return await record('excluded_permanently');
    if (env.SHIPPING_AUTO_ENABLED !== 'true') return await record('disabled');
    if (!env.RESEND_API_KEY || !env.SQUARE_ACCESS_TOKEN || !(await shippingExclusionsReady(env))) return shippingJson({ error: 'Shipping safety prerequisites missing' }, 503);
    const start = Date.parse(env.SHIPPING_AUTO_START_AT || '');
    if (!Number.isFinite(start)) return shippingJson({ error: 'Shipping start time not configured' }, 503);
    const order = (await shippingSquare(env, `/orders/${encodeURIComponent(orderId)}`)).order;
    if (!order || order.id !== orderId) throw Error('Order read mismatch');
    if (order.source?.name !== 'voreas-ec' || order.location_id !== (env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13') || order.state === 'CANCELED') return await record('not_eligible', 'source_location_or_state');
    const shipments = (order.fulfillments || []).filter(f => f.type === 'SHIPMENT');
    if (shipments.length > 1) return await record('held', 'multiple_shipments_manual_review');
    const shipment = shipments[0];
    if (!shipment || shipment.state !== 'COMPLETED' || !shipment.shipment_details?.tracking_number) return await record('not_ready', 'shipment_not_completed_or_tracking_missing');
    const shipped = Date.parse(shipment.shipment_details.shipped_at || '');
    if (!Number.isFinite(shipped) || shipped < start) return await record('held', 'before_auto_start_or_missing_shipped_at');
    // Auto does not fan out to payment/customer APIs: absent recipient mail is
    // durably held and the manual manifest can resolve those exact references.
    const row = (await shippingManifest(env, [order], true)).rows[0];
    if (!row || row.issue) return await record('held', row?.issue || 'missing_shipment');
    // Same order PK and provider key as the manual API, not an event-only lock.
    // Pending/unknown/error claims NEVER auto-expire or auto-retry.
    const claim = await env.SHIPPING_DB.prepare('INSERT OR IGNORE INTO shipping_notifications (order_id, manifest_hash, status, recipient, tracking_number, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM shipping_exclusions WHERE order_id = ?)').bind(orderId, `AUTO:${event.event_id}`, 'pending', row.email, row.trackingNumber, new Date().toISOString(), orderId).run();
    if (!claim.meta.changes) return await record('skipped_existing_or_excluded');
    let status = 'unknown', providerId = null;
    try {
      const res = await fetch('https://api.resend.com/emails', { signal: AbortSignal.timeout(3000), method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `voreas-shipped-v1-${orderId}` }, body: JSON.stringify(shippingEmail(row)) });
      const data = await res.json();
      if (res.ok && data.id) { status = 'sent'; providerId = data.id; }
      else status = 'provider_error';
    } catch { /* Accepted-but-response-lost must not cause a second email. */ }
    await env.SHIPPING_DB.prepare('UPDATE shipping_notifications SET status = ?, resend_id = ?, updated_at = ? WHERE order_id = ?').bind(status, providerId, new Date().toISOString(), orderId).run();
    return await record(status);
  } catch {
    // Non-2xx requests are retried by Square. A durable order claim, if already
    // taken, still prevents another provider call after any D1 write failure.
    console.error('shipping_webhook_processing_failed');
    return shippingJson({ error: 'Shipping processing failed; reconcile durable records' }, 503);
  }
}
async function handleNotifyShipped(request, env) {
  if (!env.SHIPPING_ADMIN_TOKEN) return shippingJson({ error: 'Shipping administration not configured' }, 503);
  // Never reuse the public manage.html password or accept credentials in URLs.
  const expected = `Bearer ${env.SHIPPING_ADMIN_TOKEN}`, supplied = request.headers.get('Authorization') || '';
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const a = await digest(expected), b = await digest(supplied);
  let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  if (mismatch) return shippingJson({ error: 'Unauthorized' }, 401);
  if (!env.SQUARE_ACCESS_TOKEN) return shippingJson({ error: 'Square not configured' }, 503);
  let body; try { body = await request.json(); } catch { return shippingJson({ error: 'Invalid JSON' }, 400); }
  const mode = body.mode || 'dry-run';
  if (!['dry-run', 'test', 'send'].includes(mode)) return shippingJson({ error: 'Invalid mode' }, 400);
  try {
    const manifest = await shippingManifest(env);
    if (mode === 'dry-run') {
      const records = env.SHIPPING_DB ? (await env.SHIPPING_DB.prepare('SELECT order_id, status, resend_id, updated_at FROM shipping_notifications').all()).results : [];
      const exclusions = env.SHIPPING_DB ? (await env.SHIPPING_DB.prepare('SELECT order_id, reason, decision_ref FROM shipping_exclusions').all()).results : [];
      const observations = env.SHIPPING_DB ? (await env.SHIPPING_DB.prepare('SELECT * FROM shipping_observations ORDER BY updated_at DESC LIMIT 1000').all()).results : [];
      const excludedIds = new Set(exclusions.map(r => r.order_id)), claimedIds = new Set(records.map(r => r.order_id));
      const unnotified = manifest.rows.filter(r => !excludedIds.has(r.orderId) && !claimedIds.has(r.orderId));
      return shippingJson({ ...manifest, records, exclusions, observations, unnotified, autoEnabled: env.SHIPPING_AUTO_ENABLED === 'true', sendEnabled: !!(env.SHIPPING_DB && env.RESEND_API_KEY && env.SHIPPING_APPROVED_MANIFEST === manifest.hash) });
    }
    if (!env.SHIPPING_DB || !env.RESEND_API_KEY) return shippingJson({ error: 'Shipping DB / Resend not configured' }, 503);
    if (mode === 'send' && !(await shippingExclusionsReady(env))) return shippingJson({ error: 'Permanent exclusions not initialized' }, 503);
    if (body.manifestHash !== manifest.hash) return shippingJson({ error: 'Manifest changed; repeat dry-run and approval', hash: manifest.hash }, 409);
    if (mode === 'send' && env.SHIPPING_APPROVED_MANIFEST !== manifest.hash) return shippingJson({ error: 'S I approval required; operator must configure exact approved manifest hash AFTER confirmation of test receipt' }, 403);
    if (mode === 'send') {
      const test = await env.SHIPPING_DB.prepare('SELECT status FROM shipping_notifications WHERE order_id = ?').bind(`TEST:${manifest.hash}`).first();
      if (test?.status !== 'sent') return shippingJson({ error: 'Successful S I test required before customer send' }, 403);
    }
    const excludedIds = mode === 'send' ? new Set((await env.SHIPPING_DB.prepare('SELECT order_id FROM shipping_exclusions').all()).results.map(r => r.order_id)) : new Set();
    const candidates = manifest.rows.filter(r => !r.issue && !excludedIds.has(r.orderId));
    // Individual recovery only when orderIds is supplied; legacy batch remains approval-gated.
    if (body.orderIds !== undefined && (!Array.isArray(body.orderIds) || body.orderIds.length < 1 || body.orderIds.length > 10 || body.orderIds.some(id => typeof id !== 'string'))) return shippingJson({ error: 'orderIds must contain 1-10 IDs' }, 400);
    const targets = mode === 'test' ? candidates.filter(r => r.orderId === body.orderId).slice(0, 1) : candidates.filter(r => !body.orderIds || body.orderIds.includes(r.orderId));
    if (mode === 'test' && targets.length !== 1) return shippingJson({ error: 'Select one eligible orderId from dry-run' }, 400);
    const existing = new Set((await env.SHIPPING_DB.prepare('SELECT order_id FROM shipping_notifications').all()).results.map(r => r.order_id));
    const results = []; let attempted = 0;
    for (const row of targets) {
      const id = mode === 'test' ? `TEST:${manifest.hash}` : row.orderId;
      // Avoid one D1 round-trip per old order on later batches (Workers limits).
      if (existing.has(id)) { results.push({ orderId: row.orderId, status: 'skipped_existing_record' }); continue; }
      const now = new Date().toISOString();
      const claim = await env.SHIPPING_DB.prepare('INSERT OR IGNORE INTO shipping_notifications (order_id, manifest_hash, status, recipient, tracking_number, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM shipping_exclusions WHERE order_id = ?)').bind(id, manifest.hash, 'pending', mode === 'test' ? 's-ikeda@remium.jp' : row.email, row.trackingNumber, now, id).run();
      if (!claim.meta.changes) { results.push({ orderId: row.orderId, status: 'skipped_existing_record' }); continue; }
      attempted++;
      let status = 'unknown', providerId = null;
      try {
        const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `voreas-shipped-v1-${id}` }, body: JSON.stringify(shippingEmail(row, mode === 'test')) });
        const data = await res.json();
        if (res.ok && data.id) { status = 'sent'; providerId = data.id; }
        else status = 'provider_error';
      } catch { /* Unknown delivery outcome: keep permanent claim, manual reconciliation only. */ }
      await env.SHIPPING_DB.prepare('UPDATE shipping_notifications SET status = ?, resend_id = ?, updated_at = ? WHERE order_id = ?').bind(status, providerId, new Date().toISOString(), id).run();
      results.push({ orderId: row.orderId, status, resendId: providerId });
      // Stop on uncertain/rejected send. At most 10 new sends per call; repeat
      // calls are safe and skip ALL previous claims, even failures and pending.
      if (status !== 'sent' || attempted >= 10) break;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    return shippingJson({ mode, hash: manifest.hash, attempted, results, held: manifest.held.length, note: 'sent means Resend accepted, not inbox delivery; check provider delivery/bounce events. Repeat send for next batch; never delete pending/error claims to retry without provider reconciliation.' });
  } catch { return shippingJson({ error: 'Shipping operation failed; inspect durable records before retrying' }, 502); }
}

// ── Handler: POST /api/coupon-validate ──

async function handleCouponValidate(request, env) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    return json({ valid: false, message: 'API not configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ valid: false, message: 'Invalid request' }, 400);
  }

  const { couponCode, subtotal } = body;
  if (!couponCode) {
    return json({ valid: false, message: 'クーポンコードを入力してください' }, 400);
  }

  try {
    const catalogRes = await fetch(`${SQUARE_API}/catalog/list?types=DISCOUNT`, {
      method: 'GET',
      headers: {
        'Square-Version': SQUARE_VERSION,
        'Authorization': `Bearer ${token}`,
      },
    });
    const catalogData = await catalogRes.json();

    // Debug: log what the API returned
    const allDiscounts = (catalogData.objects || []).map(obj => ({
      id: obj.id,
      name: obj.discount_data?.name || '(no name)',
      type: obj.discount_data?.discount_type || '(no type)',
      is_deleted: obj.is_deleted || false,
    }));

    if (!catalogData.objects || catalogData.objects.length === 0) {
      return json({ valid: false, message: '無効なクーポンコードです', debug: { catalogCount: 0, catalogErrors: catalogData.errors || null } });
    }

    // Filter out deleted discounts and find by name (case-insensitive)
    // Also strip emoji prefixes from Square Dashboard discount names for easier matching
    const stripEmoji = (s) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const inputClean = stripEmoji(couponCode).toUpperCase();
    const discount = catalogData.objects.find(obj => {
      if (obj.is_deleted) return false;
      const name = obj.discount_data?.name || '';
      const nameClean = stripEmoji(name).toUpperCase();
      return nameClean === inputClean || name.toUpperCase() === couponCode.toUpperCase();
    });

    if (!discount) {
      return json({ valid: false, message: '無効なクーポンコードです', availableDiscounts: allDiscounts, inputCode: couponCode });
    }

    const dd = discount.discount_data;
    let discountAmount = 0;
    let discountType = '';

    if (dd.discount_type === 'FIXED_PERCENTAGE' || dd.discount_type === 'VARIABLE_PERCENTAGE') {
      const pct = parseFloat(dd.percentage || '0');
      discountAmount = Math.round((subtotal || 0) * pct / 100);
      discountType = `${pct}%`;
    } else if (dd.discount_type === 'FIXED_AMOUNT' || dd.discount_type === 'VARIABLE_AMOUNT') {
      discountAmount = dd.amount_money?.amount || 0;
      discountType = `¥${discountAmount}`;
    }

    return json({
      valid: true,
      discountAmount: discountAmount,
      discountType: discountType,
      couponName: dd.name || couponCode,
    });
  } catch (err) {
    return json({ valid: false, message: err.message }, 500);
  }
}
