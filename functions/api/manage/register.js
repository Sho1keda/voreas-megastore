// Cloudflare Pages Function — Square Catalog API product registration
// POST /api/manage/register
// Body: { type, colors, sizes, players, priceWolves, pricePlayer, category, imageFile }
// Creates items + variations in Square Catalog

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2025-01-01';

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
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { type, colors, sizes, players, priceWolves, pricePlayer, category } = body;
  const typeLabel = TYPE_LABELS[type] || '商品';

  // Build all items
  const objects = [];
  for (const colorRaw of colors) {
    const color = COLOR_MAP[colorRaw.toLowerCase()] || colorRaw.toUpperCase();
    for (const player of players) {
      const itemId = `#manage-${Date.now()}-${type}-${color}-${player.no}`;
      const displayName = player.no === 1 ? `#1WOLVES` : `#${player.no}/${player.name}`;
      const itemName = `2026-27シーズン${typeLabel}[${color}]${displayName}`;
      const price = player.no === 1 ? priceWolves : pricePlayer;

      const variations = sizes.map((size, i) => ({
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

  // Submit in chunks
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
          'Square-Version': SQUARE_VERSION,
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
    return new Response(JSON.stringify({
      success: false,
      error: errors.map(e => e.detail || e.code).join(', '),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    success: true,
    itemCount: totalItems,
    variationCount: totalVariations,
    errors: errors.length > 0 ? errors.slice(0, 3) : undefined,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
