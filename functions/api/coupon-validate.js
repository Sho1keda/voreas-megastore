// Cloudflare Pages Function — Coupon validation
// POST /api/coupon-validate
// Body: { couponCode, subtotal }

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-08-21';

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = env.SQUARE_ACCESS_TOKEN;

  if (!token) {
    return new Response(JSON.stringify({ valid: false, message: 'API not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ valid: false, message: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { couponCode, subtotal } = body;
  if (!couponCode) {
    return new Response(JSON.stringify({ valid: false, message: 'クーポンコードを入力してください' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Search Square Catalog for discounts
    const catalogRes = await fetch(`${SQUARE_API}/catalog/list?types=DISCOUNT`, {
      method: 'GET',
      headers: {
        'Square-Version': SQUARE_VERSION,
        'Authorization': `Bearer ${token}`,
      },
    });
    const catalogData = await catalogRes.json();

    if (!catalogData.objects) {
      return new Response(JSON.stringify({ valid: false, message: '無効なクーポンコードです' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Find discount by name (coupon code = discount name in Square Dashboard)
    const discount = catalogData.objects.find(obj => {
      const name = obj.discount_data?.name || '';
      return name.toUpperCase() === couponCode.toUpperCase();
    });

    if (!discount) {
      return new Response(JSON.stringify({ valid: false, message: '無効なクーポンコードです' }), {
        headers: { 'Content-Type': 'application/json' },
      });
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

    return new Response(JSON.stringify({
      valid: true,
      discountAmount: discountAmount,
      discountType: discountType,
      couponName: dd.name || couponCode,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
