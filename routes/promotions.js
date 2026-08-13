const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { calculateProductPrice, calculateCartPrice, getEligiblePromotionsForProduct } = require('../services/promotionEngine');

// ============ PUBLIC PROMOTION APIS ============

// Get all active promotions (for customer-facing Offers page)
router.get('/', (req, res) => {
  const db = getDb();
  const promotions = db.all(`
    SELECT id, name, description, discount_type, discount_value, scope, 
           min_order_value, max_discount, start_date, end_date, 
           is_active, usage_limit, used_count, priority, allow_stacking, created_at
    FROM promotions
    WHERE is_active = 1 
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
    ORDER BY priority DESC, created_at DESC
  `);
  
  // Parse JSON fields
  promotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });
  
  res.json(promotions);
});

// Get active promotions with eligible products (for Offers page display)
router.get('/offers', (req, res) => {
  const db = getDb();
  const promotions = db.all(`
    SELECT id, name, description, discount_type, discount_value, scope,
           products, categories, min_order_value, max_discount, start_date, end_date,
           is_active, usage_limit, used_count, priority, allow_stacking, created_at
    FROM promotions
    WHERE is_active = 1
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
    ORDER BY priority DESC, created_at DESC
  `);
  
  // For each promotion, get eligible products
  const result = promotions.map(p => {
    let eligibleProducts = [];
    
    if (p.scope === 'all_products') {
      eligibleProducts = db.all(`
        SELECT f.id, f.name, f.image, f.price, f.discount_price, f.is_veg, f.is_available,
               c.name as category_name
        FROM food_items f
        LEFT JOIN categories c ON f.category_id = c.id
        WHERE f.is_available = 1
        LIMIT 12
      `);
    } else if (p.scope === 'category') {
      try {
        const catIds = JSON.parse(p.categories || '[]');
        if (catIds.length > 0) {
          const placeholders = catIds.map(() => '?').join(',');
          eligibleProducts = db.all(`
            SELECT f.id, f.name, f.image, f.price, f.discount_price, f.is_veg, f.is_available,
                   c.name as category_name
            FROM food_items f
            LEFT JOIN categories c ON f.category_id = c.id
            WHERE f.category_id IN (${placeholders}) AND f.is_available = 1
            LIMIT 12
          `, catIds);
        }
      } catch(e) {}
    } else if (p.scope === 'product') {
      try {
        const prodIds = JSON.parse(p.products || '[]');
        if (prodIds.length > 0) {
          const placeholders = prodIds.map(() => '?').join(',');
          eligibleProducts = db.all(`
            SELECT f.id, f.name, f.image, f.price, f.discount_price, f.is_veg, f.is_available,
                   c.name as category_name
            FROM food_items f
            LEFT JOIN categories c ON f.category_id = c.id
            WHERE f.id IN (${placeholders}) AND f.is_available = 1
          `, prodIds);
        }
      } catch(e) {}
    }
    
    // Calculate effective prices for each product
    eligibleProducts.forEach(product => {
      const basePrice = product.discount_price || product.price;
      const priceInfo = calculateProductPrice(basePrice, [p]);
      product.basePrice = basePrice;
      product.effectivePrice = priceInfo.effectivePrice;
      product.discountAmount = priceInfo.discountAmount;
      product.selectedPromotion = priceInfo.selectedPromotion;
    });
    
    return {
      ...p,
      products: eligibleProducts,
      products_count: eligibleProducts.length
    };
  });
  
  res.json(result);
});

// Calculate price for a product with promotions
router.post('/calculate-product', (req, res) => {
  const { food_item_id, quantity = 1 } = req.body;
  
  if (!food_item_id) {
    return res.status(400).json({ error: 'food_item_id is required' });
  }
  
  const db = getDb();
  const foodItem = db.get('SELECT * FROM food_items WHERE id = ? AND is_available = 1', [food_item_id]);
  
  if (!foodItem) {
    return res.status(404).json({ error: 'Food item not found or unavailable' });
  }
  
  const basePrice = foodItem.discount_price || foodItem.price;
  
  // Get all active promotions
  const allPromotions = db.all(`
    SELECT * FROM promotions
    WHERE is_active = 1 
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
  `);
  
  // Parse JSON fields
  allPromotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });
  
  // Get eligible promotions for this product
  const eligiblePromotions = getEligiblePromotionsForProduct(foodItem.id, allPromotions);
  
  // Calculate effective price
  const priceInfo = calculateProductPrice(basePrice, eligiblePromotions);
  
  res.json({
    food_item_id: foodItem.id,
    name: foodItem.name,
    basePrice: basePrice,
    effectivePrice: priceInfo.effectivePrice,
    discountAmount: priceInfo.discountAmount,
    quantity: quantity,
    totalPrice: priceInfo.effectivePrice * quantity,
    eligiblePromotions: priceInfo.eligiblePromotions,
    selectedPromotion: priceInfo.selectedPromotion
  });
});

// Calculate cart total with promotions
router.post('/calculate-cart', (req, res) => {
  const { items, coupon_code } = req.body;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items array is required' });
  }
  
  const db = getDb();
  
  // Get all active promotions
  const allPromotions = db.all(`
    SELECT * FROM promotions
    WHERE is_active = 1 
      AND (start_date IS NULL OR start_date <= datetime('now'))
      AND (end_date IS NULL OR end_date > datetime('now'))
      AND (usage_limit IS NULL OR used_count < usage_limit)
  `);
  
  // Parse JSON fields
  allPromotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });
  
  // Build cart items with base prices
  const cartItems = [];
  let subtotal = 0;

  for (const item of items) {
    const food = db.get('SELECT * FROM food_items WHERE id = ? AND is_available = 1', [item.food_item_id]);
    if (!food) {
      return res.status(400).json({ error: `Food item ${item.food_item_id} not found or unavailable` });
    }

    const basePrice = food.discount_price || food.price;
    const qty = parseInt(item.quantity) || 1;
    const itemTotal = basePrice * qty;
    subtotal += itemTotal;

    cartItems.push({
      food_item_id: food.id,
      name: food.name,
      quantity: qty,
      basePrice: basePrice,
      itemTotal: itemTotal,
      category_id: food.category_id
    });
  }
  
  // Calculate cart price with promotions
  const cartPrice = calculateCartPrice(cartItems, allPromotions, { subtotal });
  
  // Apply coupon if provided
  let couponDiscount = 0;
  let couponInfo = null;
  if (coupon_code) {
    const { validateCoupon } = require('../utils/helpers');
    const result = validateCoupon(coupon_code, cartPrice.effectiveSubtotal);
    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }
    couponDiscount = result.discount;
    couponInfo = result.coupon;
  }
  
  const grandTotal = cartPrice.effectiveSubtotal - couponDiscount;
  
  res.json({
    subtotal: cartPrice.subtotal,
    promotion_discount: cartPrice.discount,
    coupon_discount: couponDiscount,
    total_discount: cartPrice.discount + couponDiscount,
    effective_subtotal: cartPrice.effectiveSubtotal,
    grand_total: grandTotal,
    selectedPromotion: cartPrice.selectedPromotion,
    eligiblePromotions: cartPrice.eligiblePromotions,
    coupon: couponInfo
  });
});

// Get promotion by ID
router.get('/:id', (req, res) => {
  const db = getDb();
  const promotion = db.get('SELECT * FROM promotions WHERE id = ?', [req.params.id]);
  if (!promotion) {
    return res.status(404).json({ error: 'Promotion not found' });
  }
  
  try { promotion.products = promotion.products ? JSON.parse(promotion.products) : []; } catch(e) { promotion.products = []; }
  try { promotion.categories = promotion.categories ? JSON.parse(promotion.categories) : []; } catch(e) { promotion.categories = []; }
  
  res.json(promotion);
});

module.exports = router;
