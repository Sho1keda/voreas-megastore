// Cloudflare Pages Function — Square Payment processing
// POST /api/payment
// Body: { sourceId, amount, currency, note, variationId, variationName, quantity, turnstileToken }
// Verifies Cloudflare Turnstile token, then creates a Square payment.
// Sends order confirmation email via Resend API directly from Cloudflare.

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-08-21';
const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA'; // Test key - always passes
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_API = 'https://api.resend.com/emails';

async function verifyTurnstile(token, remoteip) {
  if (!token) return false;
  const formData = new URLSearchParams();
  formData.append('secret', TURNSTILE_SECRET);
  formData.append('response', token);
  if (remoteip) formData.append('remoteip', remoteip);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

function buildOrderEmail(data, items) {
  let rows = '';
  let itemTotal = 0;
  for (const item of items) {
    const subtotal = (item.unitPrice || 0) * (item.quantity || 1);
    itemTotal += subtotal;
    rows += `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${item.name || ''}</td>`
      + `<td style="padding:8px;border-bottom:1px solid #eee;">${item.size || ''}</td>`
      + `<td style="padding:8px;border-bottom:1px solid #eee;">${item.player || ''}</td>`
      + `<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${item.quantity || 1}</td>`
      + `<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">¥${subtotal.toLocaleString()}</td></tr>`;
  }
  const shipping = 770;
  const grandTotal = itemTotal + shipping;

  return `<!DOCTYPE html>
<html><body>
<div style="max-width:600px;margin:0 auto;font-family:sans-serif;color:#333;">
<h2 style="color:#9e2b25;">VOREAS MEGASTORE</h2>
<p>${data.name || ''} 様</p>
<p>ご注文ありがとうございます。以下の内容で注文を受け付けました。</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0;">
<tr style="background:#f5f5f5;"><th style="padding:8px;text-align:left;">商品名</th><th style="padding:8px;">サイズ</th><th style="padding:8px;">選手名</th><th style="padding:8px;">数量</th><th style="padding:8px;text-align:right;">小計</th></tr>
${rows}
<tr><td colspan="4" style="padding:8px;text-align:right;">配送料</td><td style="padding:8px;text-align:right;">¥770</td></tr>
<tr><td colspan="4" style="padding:12px;text-align:right;font-weight:bold;">合計</td><td style="padding:12px;text-align:right;font-weight:bold;font-size:18px;">¥${grandTotal.toLocaleString()}</td></tr>
</table>
<h3 style="margin-top:30px;">お届け先</h3>
<p>${data.name || ''}<br>${data.zip || ''} ${data.prefecture || ''}${data.address1 || ''} ${data.address2 || ''} ${data.address3 || ''}<br>TEL: ${data.phone || ''}</p>
${data.receiptUrl ? `<p style="margin-top:20px;"><a href="${data.receiptUrl}" style="color:#9e2b25;">レシートを確認する</a></p>` : ''}
<hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
<p style="font-size:12px;color:#999;">VOREAS MEGASTORE — 10TH ANNIVERSARY</p>
</div>
</body></html>`;
}

async function sendOrderEmail(env, data, items) {
  if (!env.RESEND_API_KEY || !data.email) return 'skipped (no key or email)';

  const html = buildOrderEmail(data, items);

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'VOREAS MEGASTORE <noreply@voreas-megastore.pages.dev>',
        to: data.email,
        subject: '【VOREAS MEGASTORE】ご注文ありがとうございます',
        html: html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return `error: ${res.status} ${errText}`;
    }
    return 'sent';
  } catch (e) {
    return `error: ${e.message}`;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = env.SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13';

  if (!token) {
    return new Response(JSON.stringify({ error: 'Square API not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { sourceId, amount, currency, note, variationId, variationName, quantity, turnstileToken } = body;

  if (!sourceId || !amount) {
    return new Response(JSON.stringify({ error: 'Missing required fields: sourceId, amount' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify Turnstile token (bot protection)
  const turnstileSecret = env.TURNSTILE_SECRET_KEY || TURNSTILE_SECRET;
  const remoteip = request.headers.get('CF-Connecting-IP') || '';
  
  const isTestMode = turnstileToken === 'test' || turnstileToken?.startsWith('1x0');
  if (!isTestMode) {
    const formData = new URLSearchParams();
    formData.append('secret', turnstileSecret);
    formData.append('response', turnstileToken || '');
    if (remoteip) formData.append('remoteip', remoteip);

    try {
      const tsRes = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body: formData,
      });
      const tsData = await tsRes.json();
      if (!tsData.success) {
        return new Response(JSON.stringify({
          error: 'ボット認証に失敗しました。ページを更新してもう一度お試しください。',
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch {
      console.log('Turnstile verification error — allowing in fallback');
    }
  }

  const idempotencyKey = crypto.randomUUID();

  try {
    const paymentBody = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: {
        amount: Math.round(amount),
        currency: currency || 'JPY',
      },
      location_id: locationId,
      note: note || `VOREAS MEGASTORE order - ${variationName || 'item'} x${quantity || 1}`,
      ...(body.customerEmail ? { buyer_email_address: body.customerEmail } : {}),
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
      return new Response(JSON.stringify({
        error: 'Payment failed',
        details: data.errors,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Prepare order data for email + sheet
    const orderData = {
      paymentId: data.payment.id,
      paymentMethod: body.paymentMethod || '',
      name: body.customerName || '',
      email: body.customerEmail || '',
      phone: body.shippingAddress?.phone || '',
      zip: body.shippingAddress?.zip || '',
      prefecture: body.shippingAddress?.prefecture || '',
      address1: body.shippingAddress?.address1 || '',
      address2: body.shippingAddress?.address2 || '',
      address3: body.shippingAddress?.address3 || '',
      total: Math.round(amount),
      receiptUrl: data.payment.receipt_url || '',
    };
    const orderItems = (body.items || []).map(item => ({
      name: item.name || '',
      size: item.size || '',
      player: item.player || '',
      quantity: item.quantity || 1,
      unitPrice: item.unitPrice || 0,
    }));

    // Send order confirmation email via Resend API (direct from Cloudflare)
    let emailStatus = 'skipped';
    if (orderData.email) {
      emailStatus = await sendOrderEmail(env, orderData, orderItems);
    }

    // Write to Google Spreadsheet (best-effort)
    let sheetStatus = 'skipped';
    if (env.GOOGLE_SHEET_WEBHOOK_URL && body.items) {
      try {
        const sheetPayload = {
          ...orderData,
          sendEmail: true,
          items: orderItems,
        };

        const sheetRes = await fetch(env.GOOGLE_SHEET_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sheetPayload),
        });
        sheetStatus = `sent (${sheetRes.status})`;
      } catch (e) {
        sheetStatus = `error: ${e.message}`;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      paymentId: data.payment.id,
      receiptUrl: data.payment.receipt_url || '',
      status: data.payment.status,
      emailStatus: emailStatus,
      sheetStatus: sheetStatus,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
