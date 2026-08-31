/**
 * Cart System for VOREAS MEGASTORE
 * 
 * - Uses localStorage to persist cart across pages
 * - Product pages: "カートに入れる" button adds item, then navigates to cart
 * - Cart page: displays items, quantity controls, total, Square checkout
 */

const SQUARE_APP_ID = 'sq0idp-g2Mj1iNjRKN-3IjNcLIRIw';
const SQUARE_LOCATION_ID = 'WMTQJASMPBH13';

// --- Cart storage helpers ---

const CART_KEY = 'voreas_cart';

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
}

function addToCart(item) {
  const cart = getCart();
  // Check if same product+size+player already in cart
  const existing = cart.find(i =>
    i.productId === item.productId &&
    i.size === item.size &&
    i.player === item.player
  );
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    cart.push(item);
  }
  saveCart(cart);
}

function removeFromCart(index) {
  const cart = getCart();
  cart.splice(index, 1);
  saveCart(cart);
}

function updateCartQty(index, qty) {
  const cart = getCart();
  if (cart[index]) {
    cart[index].quantity = Math.max(1, qty);
    saveCart(cart);
  }
}

function clearCart() {
  saveCart([]);
}

function formatPrice(amount) {
  return '¥' + amount.toLocaleString();
}

// --- Product page: Add to cart logic ---

document.addEventListener('DOMContentLoaded', async () => {
  const body = document.body;
  const productType = body.dataset.productType;
  const productColor = body.dataset.productColor;

  if (!productType || !productColor) return;
  // Only run add-to-cart logic on product pages (not cart page)
  if (body.dataset.page === 'cart') return;

  let squareProduct = null;
  let allSquareVariations = [];
  let basePrice = getCurrentBasePrice();
  let currentVariation = null;
  let selectedSize = null;
  let selectedPlayer = null;
  let quantity = 1;

  // --- 0. Register size button handlers immediately (before async fetch) ---
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('selected'));
      this.classList.add('selected');
      selectedSize = this.dataset.size;
      const priceAttr = this.dataset.price;
      if (priceAttr) {
        basePrice = parseInt(priceAttr);
        const priceEl = document.querySelector('.product-info__price-value');
        if (priceEl) priceEl.textContent = formatPrice(basePrice);
        updateTotal();
      }
    });
  });

  // Quantity controls
  window.changeQty = function(delta) {
    const input = document.getElementById('qtyInput');
    if (!input) return;
    let val = parseInt(input.value) + delta;
    if (val < 1) val = 1;
    input.value = val;
    quantity = val;
    updateTotal();
  };

  const qtyInput = document.getElementById('qtyInput');
  if (qtyInput) {
    qtyInput.addEventListener('change', () => {
      quantity = parseInt(qtyInput.value) || 1;
      updateTotal();
    });
  }

  // Player selector
  const playerSelect = document.getElementById('playerSelect');
  if (playerSelect) {
    playerSelect.addEventListener('change', () => {
      selectedPlayer = playerSelect.value;
    });
  }

  // --- 1. Try to fetch product from Square ---
  try {
    const res = await fetch(`/api/products?type=${productType}&color=${productColor}`);
    if (res.ok) {
      const data = await res.json();
      if (data.found && data.products.length > 0) {
        squareProduct = data.products[0];
        applySquareProduct(squareProduct, data.products);
        basePrice = squareProduct.variations[0]?.price || basePrice;
      }
    }
  } catch (e) {
    console.log('Square sync: using mockup data');
  }

  // --- 2. Replace "予約する" with "カートに入れる" ---
  setupAddToCartButton();

  // --- Helper functions ---

  function getCurrentBasePrice() {
    const priceEl = document.querySelector('.product-info__price-value');
    if (priceEl) {
      const match = priceEl.textContent.match(/[\d,]+/);
      if (match) return parseInt(match[0].replace(/,/g, ''));
    }
    return 27500;
  }

  function applySquareProduct(product, allProducts) {
    if (product.imageUrl) {
      const mainImg = document.getElementById('mainImage');
      if (mainImg) {
        mainImg.src = product.imageUrl;
        mainImg.alt = product.name;
      }
    }
    const titleEl = document.querySelector('.product-info__title');
    if (titleEl && product.name) titleEl.textContent = product.name;


    if (product.variations && product.variations.length > 0) {
      const firstVar = product.variations[0];
      const priceEl = document.querySelector('.product-info__price-value');
      if (priceEl && firstVar.price) {
        priceEl.textContent = formatPrice(firstVar.price);
        basePrice = firstVar.price;
      }
      // Collect all variations from all products (all players)
      const allVariations = (allProducts || [product]).flatMap(p =>
        (p.variations || []).map(v => ({...v, productName: p.name}))
      );
      allSquareVariations = allVariations;
      updateSizeButtons(allVariations);
      updatePlayerOptions(allProducts || [product]);
    }
    if (product.description) {
      const descEl = document.querySelector('.product-description__concept p');
      if (descEl) {
        // Render description with line breaks
        descEl.innerHTML = product.description.split('\n').map(line => {
          const div = document.createElement('div');
          div.textContent = line;
          return div.outerHTML;
        }).join('');
      }
    }
    updateTotal();
  }

  // Parse variation name "SIZE, PLAYERNAME/#NUM" → { size, playerName, playerNum }
  function parseVariationName(name) {
    const trimmed = (name || '').trim();
    // Format: "2S, NAKAMICHI/#2" or "S, WOLVES/#1"
    const m = trimmed.match(/^([^,]+),\s*(.+?)\/#(\d+)$/);
    if (m) return { size: m[1].trim(), playerName: m[2].trim(), playerNum: m[3] };
    // Fallback: just a size
    return { size: trimmed, playerName: null, playerNum: null };
  }

  function updateSizeButtons(variations) {
    const sizeContainer = document.querySelector('.product-form__sizes');
    if (!sizeContainer) return;
    // Extract unique sizes from all variations — include 2S and kids sizes
    const sizeOrder = ['2S', 'SS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', 'K.2S', 'K.S', 'K.M', 'K.L', 'K.XL', '100', '120', '140', '160', 'O/S'];
    const sizeSet = new Set();
    variations.forEach(v => {
      const parsed = parseVariationName(v.name);
      const sz = parsed.size;
      if (/^(2S|SS|XS|S|M|L|XL|2XL|3XL|K\.2S|K\.S|K\.M|K\.L|K\.XL|100|120|140|160|O\/S)$/i.test(sz)) {
        sizeSet.add(sz);
      }
    });
    if (sizeSet.size === 0) return;

    // Sort sizes by predefined order
    const sortedSizes = Array.from(sizeSet).sort((a, b) => {
      const ai = sizeOrder.indexOf(a.toUpperCase());
      const bi = sizeOrder.indexOf(b.toUpperCase());
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    sizeContainer.innerHTML = '';
    sortedSizes.forEach(sizeName => {
      // Find a variation for this size (use first matching)
      const v = variations.find(vv => parseVariationName(vv.name).size.toUpperCase() === sizeName.toUpperCase());
      const btn = document.createElement('button');
      btn.className = 'size-btn';
      btn.dataset.size = sizeName;
      btn.dataset.variationId = v ? v.id : '';
      btn.dataset.price = v ? v.price : basePrice;
      btn.textContent = sizeName;
      if (v && !v.sellable) {
        btn.classList.add('sold-out');
        btn.disabled = true;
        btn.title = '売り切れ';
      }
      btn.addEventListener('click', function() {
        document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('selected'));
        this.classList.add('selected');
        selectedSize = sizeName;
        updateVariationForSelection(allSquareVariations);
        const priceAttr = this.dataset.price;
        if (priceAttr) {
          basePrice = parseInt(priceAttr);
          const priceEl = document.querySelector('.product-info__price-value');
          if (priceEl) priceEl.textContent = formatPrice(basePrice);
        }
        updateTotal();
      });
      sizeContainer.appendChild(btn);
    });
  }

  function updateTotal() {
    const totalEl = document.getElementById('totalPrice');
    if (totalEl) {
      const total = basePrice * quantity;
      totalEl.textContent = formatPrice(total) + '（税込）';
    }
  }

  function updatePlayerOptions(products) {
    const playerSelect = document.getElementById('playerSelect');
    if (!playerSelect) return;

    // Extract player info from VARIATION names (format: "SIZE, PLAYERNAME/#NUM")
    // Variations come from allSquareVariations which is set in applySquareProduct
    const playerMap = new Map(); // dedup by player number

    allSquareVariations.forEach(v => {
      const parsed = parseVariationName(v.name);
      if (parsed.playerName && parsed.playerNum) {
        const key = `#${parsed.playerNum}`;
        if (!playerMap.has(key)) {
          playerMap.set(key, {num: parsed.playerNum, name: parsed.playerName, id: v.id});
        }
      }
    });

    // Sort by number
    const sortedPlayers = Array.from(playerMap.values()).sort((a, b) => parseInt(a.num) - parseInt(b.num));

    if (sortedPlayers.length === 0) return; // keep HTML defaults if no players found

    // Build options
    playerSelect.innerHTML = '<option value="">選手を選択してください</option>';
    sortedPlayers.forEach(p => {
      const option = document.createElement('option');
      const value = `${p.name}/#${p.num}`;
      option.value = value;
      // WOLVES gets special label
      if (p.name.toUpperCase().includes('WOLVES')) {
        option.textContent = `WOLVES（サポーターナンバー）/ #${p.num}`;
      } else {
        option.textContent = `${p.name} / #${p.num}`;
      }
      option.dataset.productId = p.id;
      option.dataset.playerNum = p.num;
      option.dataset.playerName = p.name;
      playerSelect.appendChild(option);
    });

    // Update selectedPlayer on change
    playerSelect.onchange = () => {
      selectedPlayer = playerSelect.value;
      updateVariationForSelection(allSquareVariations);
    };
  }

  function updateVariationForSelection(variations) {
    if (!variations || variations.length === 0) return;
    if (!selectedSize) return;

    // Find the product that matches the selected player
    const playerSelect = document.getElementById('playerSelect');
    const selectedOption = playerSelect ? playerSelect.selectedOptions[0] : null;
    const playerNum = selectedOption ? selectedOption.dataset.playerNum : null;
    const playerName = selectedOption ? selectedOption.dataset.playerName : null;

    // Find variation matching both size and player
    // Variation names: "SIZE, PLAYERNAME/#NUM"
    const match = variations.find(v => {
      const parsed = parseVariationName(v.name);
      const vSizeMatch = parsed.size.toUpperCase() === selectedSize.toUpperCase();
      const vPlayerMatch = playerNum
        ? (parsed.playerNum === playerNum && parsed.playerName && playerName &&
           parsed.playerName.toUpperCase() === playerName.toUpperCase())
        : true;
      return vSizeMatch && vPlayerMatch;
    });

    if (match) {
      currentVariation = match;
      if (match.price) {
        basePrice = match.price;
        const priceEl = document.querySelector('.product-info__price-value');
        if (priceEl) priceEl.textContent = formatPrice(basePrice);
        updateTotal();
      }
    }
  }

  // Quantity controls
  window.changeQty = function(delta) {
    const input = document.getElementById('qtyInput');
    if (!input) return;
    let val = parseInt(input.value) + delta;
    if (val < 1) val = 1;
    input.value = val;
    quantity = val;
    updateTotal();
  };
  // Size button selection (for non-Square mode) — moved to top, before async fetch
  // (see section 0 above)

  function setupAddToCartButton() {
    const cartBtn = document.getElementById('cartBtn');
    if (!cartBtn) return;

    // Change text to "カートに入れる"
    cartBtn.textContent = 'カートに入れる';
    cartBtn.removeAttribute('target');
    cartBtn.removeAttribute('rel');
    // Convert from <a> behavior to button behavior
    cartBtn.style.cursor = 'pointer';

    cartBtn.addEventListener('click', (e) => {
      e.preventDefault();

      // Validate size selection
      if (!selectedSize) {
        alert('サイズを選択してください。');
        return;
      }

      // Build cart item
      const productTitle = document.querySelector('.product-info__title')?.textContent || `${productType}-${productColor}`;
      const productBadge = document.querySelector('.product-info__badge')?.textContent || '';
      // Map color to local product image (Square doesn't have images set)
      const colorImageMap = {
        home: 'images/products/uniform-2026-27-red.jpg',
        red: 'images/products/uniform-2026-27-red.jpg',
        away: 'images/products/uniform-2026-27-black.jpg',
        black: 'images/products/uniform-2026-27-black.jpg',
        libero: 'images/products/uniform-2026-27-gray.jpg',
        gray: 'images/products/uniform-2026-27-gray.jpg',
        grey: 'images/products/uniform-2026-27-gray.jpg',
      };
      const fallbackImage = colorImageMap[productColor] || '';
      const cartItem = {
        productId: squareProduct?.id || `${productType}-${productColor}`,
        productType,
        productColor,
        name: productTitle,
        badge: productBadge,
        size: selectedSize,
        player: selectedPlayer || '',
        quantity: quantity,
        unitPrice: basePrice,
        variationId: currentVariation?.id || '',
        imageUrl: squareProduct?.imageUrl || fallbackImage,
      };

      addToCart(cartItem);

      // Navigate to cart page
      window.location.href = '/cart.html';
    });
  }
});
