const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const {
  getRestaurantStatus,
  getSettings,
  getHomepage,
  generateOrderNumber,
  generateTrackingId,
  createNotification,
  addOrderStatusHistory,
  validateCoupon,
  incrementCouponUsage,
  incrementPromotionUsage
} = require('../utils/helpers');
const { calculateCartPrice, getEligiblePromotionsForProduct, calculateProductPrice } = require('../services/promotionEngine');
const { signCustomerToken, verifyCustomerToken, requireCustomer } = require('../middleware/auth');

// ============ PAYMENT METHODS ============
router.get('/payment-methods', (req, res) => {
  const db = getDb();
  const settings = db.get('SELECT * FROM restaurant_settings WHERE id = 1');
  const methods = [];

  if (settings.payment_upi_enabled) {
    methods.push({
      id: 'upi',
      name: settings.payment_upi_name || 'UPI',
      type: 'upi',
      upi_id: settings.upi_id,
      enabled: true
    });
  }
  if (settings.payment_qr_enabled) {
    methods.push({
      id: 'qr',
      name: 'QR Payment',
      type: 'qr',
      qr_image: settings.payment_qr_image,
      enabled: true
    });
  }
  if (settings.payment_bank_enabled) {
    methods.push({
      id: 'bank_transfer',
      name: 'Bank Transfer',
      type: 'bank',
      account_holder: settings.payment_bank_holder,
      bank_name: settings.payment_bank_name,
      account_number: settings.payment_bank_account,
      ifsc: settings.payment_bank_ifsc,
      branch: settings.payment_bank_branch,
      enabled: true
    });
  }
  if (settings.payment_direct_enabled) {
    methods.push({
      id: 'direct_number',
      name: settings.payment_direct_name || 'Direct Payment',
      type: 'direct',
      number: settings.payment_direct_number,
      enabled: true
    });
  }

  res.json(methods);
});

// ============ CUSTOMER AUTH ============
router.post('/customer/register', (req, res) => {
  const db = getDb();
  const { name, phone, email, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!phone || !/^[+\d][\d\s-]{7,14}$/.test(phone.trim())) return res.status(400).json({ error: 'Valid phone number is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.get('SELECT * FROM customers WHERE phone = ?', [phone.trim()]);
  if (existing && existing.password_hash) {
    return res.status(400).json({ error: 'An account with this phone number already exists. Please login instead.' });
  }
  if (existing && existing.is_deleted === 1) {
    db.run('UPDATE customers SET name = ?, email = ?, password_hash = ?, is_deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE id = ?',
      [name.trim(), email ? email.trim() : null, bcrypt.hashSync(password, 10), existing.id]);
    const token = signCustomerToken({ id: existing.id, name: name.trim(), phone: phone.trim(), email: email || null });
    return res.json({ token, customer: { id: existing.id, name: name.trim(), phone: phone.trim(), email: email || null } });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.run('INSERT INTO customers (name, phone, email, password_hash) VALUES (?, ?, ?, ?)',
    [name.trim(), phone.trim(), email ? email.trim() : null, hash]);
  const token = signCustomerToken({ id: result.lastInsertRowid, name: name.trim(), phone: phone.trim(), email: email || null });
  res.status(201).json({ token, customer: { id: result.lastInsertRowid, name: name.trim(), phone: phone.trim(), email: email || null } });
});

router.post('/customer/login', (req, res) => {
  const db = getDb();
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password are required' });

  const customer = db.get('SELECT * FROM customers WHERE phone = ?', [phone.trim()]);
  if (!customer || !customer.password_hash) {
    return res.status(401).json({ error: 'Invalid phone or password' });
  }
  if (!bcrypt.compareSync(password, customer.password_hash)) {
    return res.status(401).json({ error: 'Invalid phone or password' });
  }

  const token = signCustomerToken({ id: customer.id, name: customer.name, phone: customer.phone, email: customer.email });
  res.json({ token, customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email } });
});

router.get('/customer/me', requireCustomer, (req, res) => {
  res.json({ customer: req.customer });
});

router.get('/customer/orders', requireCustomer, (req, res) => {
  const db = getDb();
  const orders = db.all('SELECT * FROM orders WHERE customer_id = ? AND is_deleted != 1 ORDER BY created_at DESC', [req.customer.id]);
  orders.forEach(o => {
    o.items = db.all('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    o.items.forEach(item => { item.addons = item.addons_json ? JSON.parse(item.addons_json) : []; });
    o.payment = db.get('SELECT * FROM payments WHERE order_id = ?', [o.id]);
  });
  res.json(orders);
});

router.get('/customer/orders/:orderNumber', requireCustomer, (req, res) => {
  const db = getDb();
  const order = db.get('SELECT * FROM orders WHERE order_number = ? AND customer_id = ? AND is_deleted != 1', [req.params.orderNumber, req.customer.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  order.items = db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  order.items.forEach(item => { item.addons = item.addons_json ? JSON.parse(item.addons_json) : []; });
  order.status_history = db.all('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC', [order.id]);
  order.payment = db.get('SELECT * FROM payments WHERE order_id = ?', [order.id]);
  res.json(order);
});

router.post('/orders/:orderNumber/submit-payment', requireCustomer, async (req, res) => {
  const db = getDb();
  const order = db.get('SELECT * FROM orders WHERE order_number = ? AND customer_id = ?', [req.params.orderNumber, req.customer.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (order.order_status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot submit payment for a cancelled order' });
  }
  const { payment_reference, payment_proof } = req.body;
  if (!payment_reference || !payment_reference.trim()) {
    return res.status(400).json({ error: 'Payment reference / UTR number is required' });
  }

  db.run('UPDATE payments SET payment_reference = ?, payment_proof = ?, status = ?, updated_at = datetime("now") WHERE order_id = ?',
    [payment_reference.trim(), payment_proof || null, 'payment_submitted', order.id]);
  db.run('UPDATE orders SET payment_status = ?, updated_at = datetime("now") WHERE id = ?', ['payment_submitted', order.id]);
  addOrderStatusHistory(order.id, 'payment_submitted', 'Payment submitted by customer');
  createNotification('payment', `Payment Submitted for ${order.order_number}`, `Customer submitted payment reference: ${payment_reference}`, 'admin', order.id);

  res.json({ message: 'Payment submitted successfully. Waiting for verification.' });
});

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, unique + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/i;
    if (!allowed.test(path.extname(file.originalname))) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

router.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const url = `/public/uploads/${req.file.filename}`;
  res.json({ url });
});

// ============ RESTAURANT INFO ============
router.get('/settings', (req, res) => {
  const db = getDb();
  const settings = db.get('SELECT * FROM restaurant_settings WHERE id = 1');
  const status = getRestaurantStatus();
  res.json({ ...settings, ...status });
});

router.get('/homepage', (req, res) => {
  const db = getDb();
  const homepage = db.get('SELECT * FROM homepage_content WHERE id = 1');
  const settings = db.get('SELECT * FROM restaurant_settings WHERE id = 1');
  const status = getRestaurantStatus();
  res.json({ homepage, settings: { ...settings, ...status } });
});

router.get('/status', (req, res) => {
  res.json(getRestaurantStatus());
});

// ============ CATEGORIES ============
router.get('/categories', (req, res) => {
  const db = getDb();
  const categories = db.all(
    'SELECT c.*, (SELECT COUNT(*) FROM food_items f WHERE f.category_id = c.id AND f.is_available = 1) as item_count FROM categories c WHERE c.is_active = 1 ORDER BY c.sort_order ASC, c.name ASC'
  );
  res.json(categories);
});

// ============ MENU / FOOD ITEMS ============
router.get('/menu', (req, res) => {
  const db = getDb();
  const { category, search, featured, popular, veg } = req.query;
  let sql = `
    SELECT f.*, c.name as category_name, c.slug as category_slug
    FROM food_items f
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE f.is_available = 1
  `;
  const params = [];

  if (category) {
    sql += ' AND c.slug = ?';
    params.push(category);
  }
  if (search) {
    sql += ` AND (f.name LIKE ? OR f.description LIKE ? OR f.ingredients LIKE ? OR c.name LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  if (featured === '1') {
    sql += ' AND f.is_featured = 1';
  }
  if (popular === '1') {
    sql += ' AND f.is_popular = 1';
  }
  if (veg === '1') {
    sql += ' AND f.is_veg = 1';
  }
  if (veg === '0') {
    sql += ' AND f.is_veg = 0';
  }

  sql += ' ORDER BY f.is_featured DESC, f.is_popular DESC, f.name ASC';
  const items = db.all(sql, params);

  // Get all active promotions
  const allPromotions = db.all(`
    SELECT * FROM promotions
    WHERE is_active = 1
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
  `);
  allPromotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });

  // Attach variants, addons, and promotion pricing
  items.forEach(item => {
    item.variants = db.all('SELECT * FROM variants WHERE food_item_id = ?', [item.id]);
    item.addons = db.all('SELECT * FROM addons WHERE food_item_id = ? AND is_available = 1', [item.id]);

    const basePrice = item.discount_price || item.price;
    const eligiblePromos = getEligiblePromotionsForProduct(item.id, allPromotions);
    const priceInfo = calculateProductPrice(basePrice, eligiblePromos);
    item.basePrice = basePrice;
    item.effectivePrice = priceInfo.effectivePrice;
    item.promotionDiscount = priceInfo.discountAmount;
    item.promotion = priceInfo.selectedPromotion;
  });

  res.json(items);
});

router.get('/menu/:id', (req, res) => {
  const db = getDb();
  const item = db.get(`
    SELECT f.*, c.name as category_name, c.slug as category_slug
    FROM food_items f
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE f.id = ? AND f.is_available = 1
  `, [req.params.id]);

  if (!item) {
    return res.status(404).json({ error: 'Food item not found' });
  }

  item.variants = db.all('SELECT * FROM variants WHERE food_item_id = ?', [item.id]);
  item.addons = db.all('SELECT * FROM addons WHERE food_item_id = ? AND is_available = 1', [item.id]);

  // Related items (same category)
  item.related = db.all(
    'SELECT * FROM food_items WHERE category_id = ? AND id != ? AND is_available = 1 LIMIT 4',
    [item.category_id, item.id]
  );

  // Calculate promotion pricing
  const allPromotions = db.all(`
    SELECT * FROM promotions
    WHERE is_active = 1
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
  `);
  allPromotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });

  const basePrice = item.discount_price || item.price;
  const eligiblePromos = getEligiblePromotionsForProduct(item.id, allPromotions);
  const priceInfo = calculateProductPrice(basePrice, eligiblePromos);
  item.basePrice = basePrice;
  item.effectivePrice = priceInfo.effectivePrice;
  item.promotionDiscount = priceInfo.discountAmount;
  item.promotion = priceInfo.selectedPromotion;

  res.json(item);
});

// ============ SEARCH SUGGESTIONS ============
router.get('/search/suggestions', (req, res) => {
  const db = getDb();
  const { q } = req.query;
  if (!q || q.trim().length < 1) {
    return res.json([]);
  }
  const term = `%${q.trim()}%`;
  const items = db.all(`
    SELECT f.id, f.name, f.image, f.price, f.discount_price, f.is_veg, c.name as category_name
    FROM food_items f
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE f.is_available = 1 AND (f.name LIKE ? OR f.description LIKE ? OR f.ingredients LIKE ? OR c.name LIKE ?)
    ORDER BY f.is_popular DESC, f.name ASC
    LIMIT 8
  `, [term, term, term, term]);

  const categories = db.all(`
    SELECT c.id, c.name, c.slug, c.image
    FROM categories c
    WHERE c.is_active = 1 AND c.name LIKE ?
    LIMIT 4
  `, [term]);

  res.json({ items, categories });
});

// ============ COUPONS ============
router.get('/coupons', (req, res) => {
  const db = getDb();
  const coupons = db.all(`
    SELECT code, description, discount_type, discount_value, min_order_value, max_discount, expiry_date
    FROM coupons
    WHERE is_active = 1 AND (expiry_date IS NULL OR expiry_date > datetime('now'))
  `);
  res.json(coupons);
});

router.post('/coupons/validate', (req, res) => {
  const { code, subtotal } = req.body;
  if (!code || !subtotal) {
    return res.status(400).json({ error: 'Coupon code and subtotal are required' });
  }
  const result = validateCoupon(code, subtotal);
  if (!result.valid) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ valid: true, discount: result.discount, coupon: result.coupon });
});

// ============ REVIEWS ============
router.get('/reviews', (req, res) => {
  const db = getDb();
  const reviews = db.all(`
    SELECT id, customer_name, rating, review_text, photo, created_at
    FROM reviews
    WHERE is_approved = 1
    ORDER BY is_featured DESC, created_at DESC
  `);
  res.json(reviews);
});

router.post('/reviews', (req, res) => {
  try {
    const db = getDb();
    const { customer_name, customer_phone, rating, review_text, photo } = req.body;

    if (!customer_name || !rating) {
      return res.status(400).json({ error: 'Name and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const result = db.run(
      'INSERT INTO reviews (customer_name, customer_phone, rating, review_text, photo) VALUES (?, ?, ?, ?, ?)',
      [customer_name, customer_phone, rating, review_text || '', photo || null]
    );

    createNotification('review', 'New Review Submitted', `${customer_name} submitted a ${rating}-star review`, 'admin');

    res.status(201).json({ id: result.lastInsertRowid, message: 'Review submitted successfully. It will appear after approval.' });
  } catch (e) {
    console.error('Review route error:', e);
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

// ============ ORDERS ============
router.post('/orders', requireCustomer, (req, res) => {
  const db = getDb();
  const {
    customer_name,
    customer_phone,
    customer_address,
    customer_landmark,
    customer_area,
    customer_pincode,
    delivery_instructions,
    items,
    payment_method,
    coupon_code
  } = req.body;

  // ===== Validation =====
  if (!customer_name || !customer_name.trim()) {
    return res.status(400).json({ error: 'Customer name is required' });
  }
  if (!customer_phone || !/^[+\d][\d\s-]{7,14}$/.test(customer_phone.trim())) {
    return res.status(400).json({ error: 'Valid phone number is required' });
  }
  if (!customer_address || !customer_address.trim()) {
    return res.status(400).json({ error: 'Delivery address is required' });
  }
  if (!customer_pincode || !/^\d{6}$/.test(customer_pincode.trim())) {
    return res.status(400).json({ error: 'Valid 6-digit pincode is required' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }
  const validPayments = ['cod', 'upi', 'phonepe', 'gpay', 'credit_card', 'debit_card', 'qr', 'bank_transfer', 'direct_number'];
  if (!validPayments.includes(payment_method)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }

  // Check restaurant open status
  const status = getRestaurantStatus();
  const settings = getSettings();
  if (!status.is_open && settings.allow_ordering_when_closed !== 1) {
    return res.status(400).json({ error: 'Restaurant is currently closed. Please try again during opening hours.' });
  }

  // ===== Calculate totals =====
  let subtotal = 0;
  const orderItems = [];

  // Get all active promotions for server-side validation
  const allPromotions = db.all(`
    SELECT * FROM promotions
    WHERE is_active = 1
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
  `);
  allPromotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });

  const cartItemsForPromo = [];

  for (const item of items) {
    const food = db.get('SELECT * FROM food_items WHERE id = ? AND is_available = 1', [item.food_item_id]);
    if (!food) {
      return res.status(400).json({ error: `Food item ${item.food_item_id} not found or unavailable` });
    }

    const qty = parseInt(item.quantity) || 1;
    if (qty < 1 || qty > 20) {
      return res.status(400).json({ error: `Invalid quantity for ${food.name}` });
    }

    const unitPrice = food.discount_price || food.price;
    let itemTotal = unitPrice * qty;

    // Variant
    let variantName = null;
    if (item.variant_id) {
      const variant = db.get('SELECT * FROM variants WHERE id = ? AND food_item_id = ?', [item.variant_id, food.id]);
      if (variant) {
        variantName = variant.name;
        itemTotal += variant.price_adjustment * qty;
      }
    }

    // Addons
    let addons = [];
    if (item.addon_ids && Array.isArray(item.addon_ids)) {
      for (const addonId of item.addon_ids) {
        const addon = db.get('SELECT * FROM addons WHERE id = ? AND food_item_id = ? AND is_available = 1', [addonId, food.id]);
        if (addon) {
          addons.push({ id: addon.id, name: addon.name, price: addon.price });
          itemTotal += addon.price * qty;
        }
      }
    }

    subtotal += itemTotal;
    cartItemsForPromo.push({
      food_item_id: food.id,
      name: food.name,
      quantity: qty,
      basePrice: unitPrice,
      itemTotal: itemTotal,
      category_id: food.category_id
    });
    orderItems.push({
      food_item_id: food.id,
      food_name: food.name,
      food_image: food.image,
      quantity: qty,
      unit_price: unitPrice,
      variant_name: variantName,
      addons_json: JSON.stringify(addons),
      item_total: itemTotal
    });
  }

  // Apply promotions server-side
  const cartPriceResult = calculateCartPrice(cartItemsForPromo, allPromotions, { subtotal });
  const promotionDiscount = cartPriceResult.discount;

  if (cartPriceResult.selectedPromotion && cartPriceResult.selectedPromotion.id) {
    incrementPromotionUsage(cartPriceResult.selectedPromotion.id);
  }

  // Calculate per-item promotion discount for snapshots
  const selectedPromo = cartPriceResult.selectedPromotion;
  const itemPromoDiscounts = {};
  if (selectedPromo && promotionDiscount > 0) {
    cartItemsForPromo.forEach(ci => {
      let eligibleAmount = 0;
      if (selectedPromo.scope === 'all_products') {
        eligibleAmount = ci.itemTotal;
      } else if (selectedPromo.scope === 'category') {
        const catIds = (selectedPromo.categories || []).map(c => typeof c === 'string' ? parseInt(c) : c);
        if (catIds.includes(ci.category_id)) eligibleAmount = ci.itemTotal;
      } else if (selectedPromo.scope === 'product') {
        const prodIds = (selectedPromo.products || []).map(p => typeof p === 'string' ? parseInt(p) : p);
        if (prodIds.includes(ci.food_item_id)) eligibleAmount = ci.itemTotal;
      }
      const itemDiscount = eligibleAmount > 0 ? (eligibleAmount / subtotal) * promotionDiscount : 0;
      itemPromoDiscounts[ci.food_item_id] = Math.round(itemDiscount * 100) / 100;
    });
  }

  // ===== Coupon =====
  let couponDiscount = 0;
  let couponCode = null;
  if (coupon_code) {
    const result = validateCoupon(coupon_code, cartPriceResult.effectiveSubtotal);
    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }
    couponDiscount = result.discount;
    couponCode = result.coupon.code;
  }

  // ===== Delivery & tax =====
  const effectiveSubtotal = Math.max(0, subtotal - promotionDiscount - couponDiscount);
  const deliveryCharge = effectiveSubtotal >= settings.min_order_value ? settings.delivery_charge : settings.delivery_charge;
  const tax = effectiveSubtotal * (settings.tax_rate / 100);
  const grandTotal = effectiveSubtotal + deliveryCharge + tax;

  // Prevent negative total
  if (grandTotal < 0) {
    return res.status(400).json({ error: 'Invalid order total. Please check your cart.' });
  }

   // ===== Use authenticated customer =====
   const customerId = req.customer.id;
   db.run('UPDATE customers SET name = ?, address = ?, landmark = ?, area = ?, pincode = ? WHERE id = ?',
     [customer_name.trim(), customer_address.trim(), customer_landmark || '', customer_area || '', customer_pincode.trim(), customerId]);

  // ===== Create order =====
  const orderNumber = generateOrderNumber();
  const trackingId = generateTrackingId();
  const orderResult = db.run(`
    INSERT INTO orders (
      order_number, tracking_id, customer_id, customer_name, customer_phone, customer_address,
      customer_landmark, customer_area, customer_pincode, delivery_instructions,
      subtotal, discount, coupon_code, coupon_discount, delivery_charge, tax, grand_total,
      payment_method, payment_status, order_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    orderNumber, trackingId, customerId, customer_name.trim(), customer_phone.trim(), customer_address.trim(),
    customer_landmark || '', customer_area || '', customer_pincode.trim(), delivery_instructions || '',
    subtotal, promotionDiscount, couponCode, couponDiscount, deliveryCharge, tax, grandTotal,
    payment_method, 'pending', payment_method === 'cod' ? 'received' : 'payment_pending'
  ]);

  const orderId = orderResult.lastInsertRowid;

  // ===== Insert order items =====
  for (const oi of orderItems) {
    const promoDiscount = itemPromoDiscounts[oi.food_item_id] || 0;
    db.run(`
      INSERT INTO order_items (order_id, food_item_id, food_name, food_image, quantity, unit_price, variant_name, addons_json, item_total, promotion_discount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [orderId, oi.food_item_id, oi.food_name, oi.food_image, oi.quantity, oi.unit_price, oi.variant_name, oi.addons_json, oi.item_total, promoDiscount]);
  }

  // ===== Payment record =====
  db.run('INSERT INTO payments (order_id, method, amount, status) VALUES (?, ?, ?, ?)',
    [orderId, payment_method, grandTotal, 'pending']);

  // ===== Coupon usage =====
  if (couponCode) {
    incrementCouponUsage(couponCode);
  }

  // ===== Notifications =====
  const initialStatus = payment_method === 'cod' ? 'received' : 'payment_pending';
  addOrderStatusHistory(orderId, initialStatus, 'Order received');
  createNotification('new_order', 'New Order Received', `Order ${orderNumber} for ₹${grandTotal.toFixed(2)}`, 'admin', orderId);

  res.status(201).json({
    order_id: orderId,
    order_number: orderNumber,
    tracking_id: trackingId,
    grand_total: grandTotal,
    payment_status: 'pending',
    order_status: initialStatus,
    message: payment_method === 'cod' ? 'Order placed successfully!' : 'Order placed successfully! Please submit your payment details.'
  });
});

// ============ CUSTOMER NOTIFICATIONS ============
router.get('/orders/:orderNumber/notifications', (req, res) => {
  const db = getDb();
  const order = db.get('SELECT * FROM orders WHERE order_number = ?', [req.params.orderNumber]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  const notifications = db.all(
    'SELECT * FROM notifications WHERE order_id = ? AND recipient_type = "customer" ORDER BY created_at DESC',
    [order.id]
  );
  res.json(notifications);
});

// ============ ORDER TRACKING ============
router.get('/orders/:identifier', requireCustomer, (req, res) => {
  const db = getDb();
  const identifier = req.params.identifier;
  // Match by order_number or tracking_id
  const order = db.get('SELECT * FROM orders WHERE (order_number = ? OR tracking_id = ?) AND customer_id = ? AND is_deleted != 1', [identifier, identifier, req.customer.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  order.items = db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  order.items.forEach(item => {
    item.addons = item.addons_json ? JSON.parse(item.addons_json) : [];
  });
  order.status_history = db.all('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC', [order.id]);
  order.payment = db.get('SELECT * FROM payments WHERE order_id = ?', [order.id]);

  res.json(order);
});

module.exports = router;