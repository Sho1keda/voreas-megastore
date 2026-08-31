/**
 * Cart count badge updater — loaded on all pages
 * Updates the cart count badge in the header
 */
(function() {
  function updateCartBadge() {
    try {
      var cart = JSON.parse(localStorage.getItem('voreas_cart') || '[]');
      var count = cart.reduce(function(sum, item) { return sum + (item.quantity || 1); }, 0);
      var badge = document.getElementById('cartCountBadge');
      if (badge) {
        if (count > 0) {
          badge.textContent = count;
          badge.style.display = 'flex';
        } else {
          badge.style.display = 'none';
        }
      }
    } catch (e) {
      // ignore
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateCartBadge);
  } else {
    updateCartBadge();
  }
})();
