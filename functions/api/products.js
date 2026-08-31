// Cloudflare Pages Function — Square Catalog API proxy
// Keeps SQUARE_ACCESS_TOKEN server-side only.
// GET /api/products?season=2026-27&type=authentic&color=home
// Returns matching catalog items as JSON.

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-08-21';

// Map our product page keys to Square search patterns.
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

// Fetch image URL from Square CDN
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = env.SQUARE_ACCESS_TOKEN;
  const locationId = env.SQUARE_LOCATION_ID || 'WMTQJASMPBH13';

  if (!token) {
    return new Response(JSON.stringify({ error: 'Square API not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const key = `${url.searchParams.get('type') || ''}-${url.searchParams.get('color') || ''}`;
  const pattern = SEARCH_PATTERNS[key];

  try {
    const allItems = await fetchAllCatalogItems(token);
    const matched = [];

    for (const obj of allItems) {
      if (obj.type !== 'ITEM' || obj.is_deleted) continue;
      const name = obj.item_data.name || '';
      // Check if it matches 2026-27 season + type + color
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

        // Try to get image URL
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

    return new Response(JSON.stringify({
      found: matched.length > 0,
      products: matched,
      key,
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // 5 min cache
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
