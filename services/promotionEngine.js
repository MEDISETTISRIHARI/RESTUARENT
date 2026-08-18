const { getDb } = require('../db/database');

/**
 * PROMOTION ENGINE - Core pricing calculation service
 * 
 * Architecture:
 * Product basePrice -> Promotion Engine -> Effective Price
 * 
 * This service calculates the effective price for any product
 * considering all active promotions, ensuring consistent pricing
 * across Menu, Offers, Cart, and Checkout.
 * 
 * MANDATORY ARCHITECTURAL RULE:
 * basePrice is NEVER overwritten. Only effectivePrice is calculated.
 * This means: basePrice stays permanent, effectivePrice is derived.
 */

/**
 * Promotion scope types
 */
const SCOPE_TYPES = {
  PRODUCT: 'product',
  CATEGORY: 'category',
  ALL_PRODUCTS: 'all_products'
};

/**
 * Discount type constants
 */
const DISCOUNT_TYPES = {
  PERCENTAGE: 'percentage',
  FIXED: 'fixed'
};

/**
 * Calculate effective price for a single product
 * @param {number} basePrice - The original product price (never modified)
 * @param {Object} promotions - Active promotions applicable to this product
 * @param {Object} context - Additional context (cart value, user, etc.)
 * @returns {Object} - Calculated price breakdown
 */
function calculateProductPrice(basePrice, promotions, context = {}) {
  if (!basePrice || basePrice <= 0) {
    return {
      basePrice: 0,
      effectivePrice: 0,
      discountAmount: 0,
      eligiblePromotions: [],
      selectedPromotion: null
    };
  }

  // Filter active, non-expired promotions
  const activePromotions = promotions.filter(p =>
    p.is_active === 1 &&
    (!p.end_date || new Date(p.end_date) > new Date()) &&
    (!p.start_date || new Date(p.start_date) <= new Date())
  );

  if (activePromotions.length === 0) {
    return {
      basePrice,
      effectivePrice: basePrice,
      discountAmount: 0,
      eligiblePromotions: [],
      selectedPromotion: null
    };
  }

  // Apply business rules for promotion selection
  let selectedPromotion = null;
  let discountAmount = 0;

  // Sort by priority (higher priority first) or by discount value
  const sortedPromos = activePromotions.sort((a, b) => {
    // If both have priority, sort by priority descending
    if (a.priority !== undefined && b.priority !== undefined) {
      return (b.priority || 0) - (a.priority || 0);
    }
    // Otherwise sort by discount value descending
    return b.effective_discount - a.effective_discount;
  });

  // Check stacking rules
  const stacking = sortedPromos.some(p => p.allow_stacking === true);

  if (!stacking) {
    // Apply only the best eligible promotion
    selectedPromotion = sortedPromos[0];
    discountAmount = calculateDiscount(basePrice, selectedPromotion, context);
  } else {
    // Stacking enabled - apply according to priority
    // For simplicity, apply the highest priority/best one
    // In production, this would have explicit stacking rules
    selectedPromotion = sortedPromos[0];
    discountAmount = calculateDiscount(basePrice, selectedPromotion, context);
  }

  const effectivePrice = Math.max(0, basePrice - discountAmount);

  return {
    basePrice,
    effectivePrice: Math.round(effectivePrice * 100) / 100, // 2 decimal places
    discountAmount: Math.round(discountAmount * 100) / 100,
    eligiblePromotions: activePromotions.map(p => ({
      id: p.id,
      name: p.name,
      discount_type: p.discount_type,
      discount_value: p.discount_value,
      effective_discount: p.effective_discount || calculateDiscount(basePrice, p, context),
      scope: p.scope,
      products: p.products || [],
      categories: p.categories || []
    })),
    selectedPromotion: selectedPromotion ? {
      id: selectedPromotion.id,
      name: selectedPromotion.name,
      discount_type: selectedPromotion.discount_type,
      discount_value: selectedPromotion.discount_value,
      scope: selectedPromotion.scope
    } : null
  };
}

/**
 * Calculate discount amount for a promotion
 * @param {number} basePrice - Original price
 * @param {Object} promotion - Promotion record from DB
 * @param {Object} context - Context (cart subtotal, etc.)
 * @returns {number} - Discount amount
 */
function calculateDiscount(basePrice, promotion, context = {}) {
  const { discount_type, discount_value, max_discount, min_order_value } = promotion;
  let discount = 0;

  // Check minimum order value
  const currentSubtotal = context.subtotal || basePrice;
  if (min_order_value && currentSubtotal < min_order_value) {
    return 0; // Not eligible
  }

  if (discount_type === DISCOUNT_TYPES.PERCENTAGE) {
    discount = (basePrice * discount_value) / 100;
    // Apply maximum discount cap
    if (max_discount && discount > max_discount) {
      discount = max_discount;
    }
  } else if (discount_type === DISCOUNT_TYPES.FIXED) {
    discount = discount_value;
    // Ensure we don't go negative
    discount = Math.min(discount, basePrice);
  }

  return discount;
}

/**
 * Calculate cart total with promotions applied
 * @param {Array} cartItems - Array of { food_item_id, quantity, basePrice }
 * @param {Array} allPromotions - All active promotions from DB
 * @param {Object} context - Additional context
 * @returns {Object} - Cart total breakdown
 */
function calculateCartPrice(cartItems, allPromotions, context = {}) {
  if (!cartItems || cartItems.length === 0) {
    return {
      subtotal: 0,
      discount: 0,
      effectiveSubtotal: 0,
      eligiblePromotions: [],
      selectedPromotion: null
    };
  }

  // Calculate base subtotal and item details
  let baseSubtotal = 0;
  const itemDetails = [];

  cartItems.forEach(item => {
    const basePrice = item.basePrice || item.unitPrice || 0;
    const qty = item.quantity || 1;
    const itemTotal = basePrice * qty;
    baseSubtotal += itemTotal;

    itemDetails.push({
      food_item_id: item.food_item_id,
      name: item.name,
      category_id: item.category_id,
      quantity: qty,
      basePrice,
      itemTotal
    });
  });

  const cartSubtotal = context.subtotal || baseSubtotal;
  const eligiblePromotions = allPromotions.filter(p =>
    p.is_active === 1 &&
    (!p.end_date || new Date(p.end_date) > new Date()) &&
    (!p.start_date || new Date(p.start_date) <= new Date()) &&
    (!p.usage_limit || (p.used_count || 0) < p.usage_limit) &&
    (p.min_order_value == null || cartSubtotal >= p.min_order_value)
  );

  // Calculate eligible subtotal for each promotion based on scope
  let totalDiscount = 0;
  let selectedPromotion = null;

  const stacking = eligiblePromotions.some(p => p.allow_stacking === true);

  if (!stacking) {
    let bestDiscount = 0;
    eligiblePromotions.forEach(p => {
      const eligibleSubtotal = getEligibleSubtotalForPromotion(itemDetails, p);
      if (eligibleSubtotal <= 0) return;
      const discount = calculateCartDiscount(p, eligibleSubtotal);
      if (discount > bestDiscount) {
        bestDiscount = discount;
        selectedPromotion = p;
      }
    });
    totalDiscount = bestDiscount;
  } else {
    let bestDiscount = 0;
    eligiblePromotions.forEach(p => {
      const eligibleSubtotal = getEligibleSubtotalForPromotion(itemDetails, p);
      if (eligibleSubtotal <= 0) return;
      const discount = calculateCartDiscount(p, eligibleSubtotal);
      if (discount > bestDiscount) {
        bestDiscount = discount;
        selectedPromotion = p;
      }
    });
    totalDiscount = bestDiscount;
  }

  const effectiveSubtotal = Math.max(0, baseSubtotal - totalDiscount);

  return {
    subtotal: Math.round(baseSubtotal * 100) / 100,
    discount: Math.round(totalDiscount * 100) / 100,
    effectiveSubtotal: Math.round(effectiveSubtotal * 100) / 100,
    eligiblePromotions: eligiblePromotions.map(p => ({
      id: p.id,
      name: p.name,
      discount_type: p.discount_type,
      discount_value: p.discount_value,
      effective_discount: calculateCartDiscount(p, getEligibleSubtotalForPromotion(itemDetails, p)),
      scope: p.scope,
      products: p.products || [],
      categories: p.categories || []
    })),
    selectedPromotion: selectedPromotion ? {
      id: selectedPromotion.id,
      name: selectedPromotion.name,
      discount_type: selectedPromotion.discount_type,
      discount_value: selectedPromotion.discount_value,
      scope: selectedPromotion.scope
    } : null
  };
}

/**
 * Calculate the subtotal of items eligible for a specific promotion
 */
function getEligibleSubtotalForPromotion(itemDetails, promotion) {
  if (promotion.scope === 'all_products') {
    return itemDetails.reduce((sum, item) => sum + item.itemTotal, 0);
  } else if (promotion.scope === 'category') {
    const catIds = (promotion.categories || []).map(c => typeof c === 'string' ? parseInt(c) : c).filter(c => !isNaN(c));
    if (!catIds.length) return 0;
    return itemDetails.reduce((sum, item) => {
      const eligible = catIds.includes(item.category_id);
      return sum + (eligible ? item.itemTotal : 0);
    }, 0);
  } else if (promotion.scope === 'product') {
    const prodIds = (promotion.products || []).map(p => typeof p === 'string' ? parseInt(p) : p).filter(p => !isNaN(p));
    if (!prodIds.length) return 0;
    return itemDetails.reduce((sum, item) => {
      const eligible = prodIds.includes(item.food_item_id);
      return sum + (eligible ? item.itemTotal : 0);
    }, 0);
  }
  return 0;
}

/**
 * Calculate discount for a promotion on cart subtotal
 * @param {Object} promotion - Promotion record
 * @param {number} cartSubtotal - Current cart subtotal
 * @returns {number} - Discount amount
 */
function calculateCartDiscount(promotion, cartSubtotal) {
  const { discount_type, discount_value, max_discount, min_order_value } = promotion;
  let discount = 0;

  if (min_order_value && cartSubtotal < min_order_value) {
    return 0;
  }

  if (discount_type === DISCOUNT_TYPES.PERCENTAGE) {
    discount = (cartSubtotal * discount_value) / 100;
    if (max_discount && discount > max_discount) {
      discount = max_discount;
    }
  } else if (discount_type === DISCOUNT_TYPES.FIXED) {
    discount = discount_value;
    discount = Math.min(discount, cartSubtotal);
  }

  return discount;
}

/**
 * Get eligible promotions for a specific product
 * @param {number} foodItemId - Food item ID
 * @param {Array} allPromotions - All promotions from DB
 * @returns {Array} - Eligible promotions for this product
 */
async function getEligiblePromotionsForProduct(foodItemId, allPromotions) {
  if (!foodItemId || !allPromotions) return [];

  const db = getDb();
  const foodItem = await db.get(`
    SELECT f.*, c.slug as category_slug
    FROM food_items f
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE f.id = ?
  `, [foodItemId]);

  if (!foodItem) return [];

  const eligible = [];

  allPromotions.forEach(p => {
    if (p.is_active !== 1) return;
    if (p.end_date && new Date(p.end_date) < new Date()) return;
    if (p.start_date && new Date(p.start_date) > new Date()) return;
    if (p.usage_limit && p.used_count >= p.usage_limit) return;

    let isEligible = false;

    if (p.scope === SCOPE_TYPES.ALL_PRODUCTS) {
      isEligible = true;
    } else if (p.scope === SCOPE_TYPES.PRODUCT) {
      // Check if this specific product is included
      if (p.products && p.products.includes(foodItemId)) {
        isEligible = true;
      }
      // Also check by name match
      if (!isEligible && p.products && p.products.some(id => String(id) === String(foodItemId))) {
        isEligible = true;
      }
    } else if (p.scope === SCOPE_TYPES.CATEGORY) {
      // Check if product's category is included
      if (p.categories && p.categories.includes(foodItem.category_id)) {
        isEligible = true;
      }
      // Also check by category name
      if (!isEligible && p.categories && foodItem.category_slug) {
        const catNames = p.categories.map(c => String(c)).includes(foodItem.category_slug);
        if (catNames) isEligible = true;
      }
    }

    if (isEligible) {
      eligible.push({
        id: p.id,
        name: p.name,
        discount_type: p.discount_type,
        discount_value: p.discount_value,
        scope: p.scope,
        products: p.products || [],
        categories: p.categories || [],
        is_active: p.is_active,
        start_date: p.start_date,
        end_date: p.end_date,
        min_order_value: p.min_order_value,
        max_discount: p.max_discount,
        priority: p.priority,
        allow_stacking: p.allow_stacking
      });
    }
  });

  return eligible;
}

module.exports = {
  calculateProductPrice,
  calculateCartPrice,
  getEligiblePromotionsForProduct,
  SCOPE_TYPES,
  DISCOUNT_TYPES
};