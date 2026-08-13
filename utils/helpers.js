const { getDb } = require('../db/database');

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function generateOrderNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const db = getDb();
  const count = db.get('SELECT COUNT(*) as count FROM orders')?.count || 0;
  return `ORD-${year}-${String(count + 1).padStart(4, '0')}`;
}

function generateTrackingId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TRK-${result}`;
}

function getRestaurantStatus() {
  const db = getDb();
  const settings = db.get('SELECT * FROM restaurant_settings WHERE id = 1');
  if (!settings) return { is_open: false, reason: 'not_configured' };

  // Manual override takes precedence
  if (settings.manual_status === 0) {
    return { is_open: false, reason: 'manually_closed' };
  }
  if (settings.manual_status === 1) {
    return { is_open: true, reason: 'manually_open' };
  }

  // Auto schedule based on opening/closing times
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [openH, openM] = (settings.opening_time || '09:00').split(':').map(Number);
  const [closeH, closeM] = (settings.closing_time || '22:00').split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  if (openMinutes <= closeMinutes) {
    return { is_open: currentMinutes >= openMinutes && currentMinutes <= closeMinutes, reason: 'schedule' };
  } else {
    // Overnight schedule (e.g., 22:00 - 06:00)
    return { is_open: currentMinutes >= openMinutes || currentMinutes <= closeMinutes, reason: 'schedule' };
  }
}

function getSettings() {
  const db = getDb();
  return db.get('SELECT * FROM restaurant_settings WHERE id = 1');
}

function getHomepage() {
  const db = getDb();
  return db.get('SELECT * FROM homepage_content WHERE id = 1');
}

function createNotification(type, title, message, recipientType = 'admin', orderId = null) {
  const db = getDb();
  db.run(
    'INSERT INTO notifications (type, title, message, recipient_type, order_id) VALUES (?, ?, ?, ?, ?)',
    [type, title, message, recipientType, orderId]
  );
}

function addOrderStatusHistory(orderId, status, note = '') {
  const db = getDb();
  db.run(
    'INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)',
    [orderId, status, note]
  );
}

function validateCoupon(code, subtotal) {
  const db = getDb();
  const coupon = db.get('SELECT * FROM coupons WHERE code = ?', [code.toUpperCase()]);
  if (!coupon) return { valid: false, error: 'Invalid coupon code' };
  if (coupon.is_active !== 1) return { valid: false, error: 'Coupon is inactive' };
  if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
    return { valid: false, error: 'Coupon has expired' };
  }
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
    return { valid: false, error: 'Coupon usage limit reached' };
  }
  if (subtotal < coupon.min_order_value) {
    return { valid: false, error: `Minimum order value of ₹${coupon.min_order_value} required` };
  }

  let discount = 0;
  if (coupon.discount_type === 'percentage') {
    discount = (subtotal * coupon.discount_value) / 100;
    if (coupon.max_discount && discount > coupon.max_discount) {
      discount = coupon.max_discount;
    }
  } else {
    discount = coupon.discount_value;
  }

  return { valid: true, coupon, discount };
}

function incrementCouponUsage(code) {
  const db = getDb();
  db.run('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', [code]);
}

function incrementPromotionUsage(promotionId) {
  const db = getDb();
  db.run('UPDATE promotions SET used_count = COALESCE(used_count, 0) + 1 WHERE id = ?', [promotionId]);
}

module.exports = {
  slugify,
  generateOrderNumber,
  generateTrackingId,
  getRestaurantStatus,
  getSettings,
  getHomepage,
  createNotification,
  addOrderStatusHistory,
  validateCoupon,
  incrementCouponUsage,
  incrementPromotionUsage
};