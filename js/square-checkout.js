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
        applySquareProduct(squareProduct);
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

  function applySquareProduct(product) {
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
      updateSizeButtons(product.variations);
    }
    if (product.description) {
      const descEl = document.querySelector('.product-description__concept p');
      if (descEl) descEl.textContent = product.description;
    }
    updateTotal();
  }

  function updateSizeButtons(variations) {
    const sizeContainer = document.querySelector('.product-form__sizes');
    if (!sizeContainer) return;
    const sizeVariations = variations.filter(v =>
      /^(SS|S|M|L|XL|2XL|3XL|100|120|140|160|O\/S|XS)$/i.test(v.name.trim())
    );
    if (sizeVariations.length === 0) return;

    sizeContainer.innerHTML = '';
    sizeVariations.forEach(v => {
      const btn = document.createElement('button');
      btn.className = 'size-btn';
      btn.dataset.size = v.name;
      btn.dataset.variationId = v.id;
      btn.dataset.price = v.price;
      btn.textContent = v.name;
      if (!v.sellable) {
        btn.classList.add('sold-out');
        btn.disabled = true;
        btn.title = '売り切れ';
      }
      btn.addEventListener('click', function() {
        document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('selected'));
        this.classList.add('selected');
        selectedSize = v.name;
        currentVariation = v;
        if (v.price) {
          basePrice = v.price;
          const priceEl = document.querySelector('.product-info__price-value');
          if (priceEl) priceEl.textContent = formatPrice(v.price);
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
        imageUrl: squareProduct?.imageUrl || '',
      };

      addToCart(cartItem);

      // Navigate to cart page
      window.location.href = '/cart.html';
    });
  }
});
