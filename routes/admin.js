const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { slugify, createNotification, addOrderStatusHistory } = require('../utils/helpers');

router.use(requireAdmin);

router.get('/me', (req, res) => {
  res.json(req.user);
});

router.post('/change-password', async (req, res) => {
  const db = getDb();
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = await db.get('SELECT * FROM admin_users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await db.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
  res.json({ message: 'Password changed successfully' });
});

router.get('/dashboard', async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const todayOrders = await db.get("SELECT COUNT(*) as count, COALESCE(SUM(grand_total), 0) as revenue FROM orders WHERE DATE(created_at) = CURRENT_DATE") || { count: 0, revenue: 0 };
  const totalOrders = (await db.get('SELECT COUNT(*) as count FROM orders'))?.count || 0;
  const pendingOrders = (await db.get("SELECT COUNT(*) as count FROM orders WHERE order_status IN ('pending', 'payment_pending', 'payment_verification', 'received', 'confirmed', 'preparing', 'ready')"))?.count || 0;
  const completedOrders = (await db.get("SELECT COUNT(*) as count FROM orders WHERE order_status = 'delivered'"))?.count || 0;
  const cancelledOrders = (await db.get("SELECT COUNT(*) as count FROM orders WHERE order_status = 'cancelled'"))?.count || 0;
const totalRevenue = (await db.get("SELECT COALESCE(SUM(grand_total), 0) as total FROM orders WHERE order_status != 'cancelled'"))?.total || 0;

  const popularFoods = await db.all(`
    SELECT oi.food_name, SUM(oi.quantity) as total_qty, COUNT(DISTINCT oi.order_id) as order_count
    FROM order_items oi
    GROUP BY oi.food_name
    ORDER BY total_qty DESC
    LIMIT 5
  `);

  const recentOrders = await db.all(`
    SELECT o.*, dp.name as delivery_person_name
    FROM orders o
    LEFT JOIN delivery_persons dp ON o.delivery_person_id = dp.id
    ORDER BY o.created_at DESC
    LIMIT 8
  `);

  const pendingReviews = (await db.get("SELECT COUNT(*) as count FROM reviews WHERE is_approved = 0"))?.count || 0;
  const activeCoupons = (await db.get("SELECT COUNT(*) as count FROM coupons WHERE is_active = 1"))?.count || 0;
  const unreadNotifications = (await db.get("SELECT COUNT(*) as count FROM notifications WHERE is_read = 0 AND recipient_type = 'admin'"))?.count || 0;

  res.json({
    today_orders: todayOrders.count,
    today_revenue: todayOrders.revenue,
    total_orders: totalOrders,
    pending_orders: pendingOrders,
    completed_orders: completedOrders,
    cancelled_orders: cancelledOrders,
    total_revenue: totalRevenue,
    popular_foods: popularFoods,
    recent_orders: recentOrders,
    pending_reviews: pendingReviews,
    active_coupons: activeCoupons,
    unread_notifications: unreadNotifications
  });
});

router.get('/categories', async (req, res) => {
  const db = getDb();
  const categories = await db.all(`
    SELECT c.*, (SELECT COUNT(*) FROM food_items f WHERE f.category_id = c.id) as item_count
    FROM categories c
    ORDER BY c.sort_order ASC, c.name ASC
  `);
  res.json(categories);
});

router.post('/categories', async (req, res) => {
  const db = getDb();
  const { name, description, image, sort_order, is_active } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required' });
  }
  const slug = slugify(name);
  const existing = await db.get('SELECT * FROM categories WHERE slug = ?', [slug]);
  if (existing) {
    return res.status(400).json({ error: 'Category with this name already exists' });
  }
  const result = await db.run('INSERT INTO categories (name, slug, description, image, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [name.trim(), slug, description || '', image || null, sort_order || 0, is_active !== undefined ? is_active : 1]);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Category created' });
});

router.put('/categories/:id', async (req, res) => {
  const db = getDb();
  const { name, description, image, sort_order, is_active } = req.body;
  const category = await db.get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }
  if (name && name.trim()) {
    const slug = slugify(name);
    const existing = await db.get('SELECT * FROM categories WHERE slug = ? AND id != ?', [slug, req.params.id]);
    if (existing) {
      return res.status(400).json({ error: 'Category with this name already exists' });
    }
    await db.run('UPDATE categories SET name = ?, slug = ? WHERE id = ?', [name.trim(), slug, req.params.id]);
  }
  if (description !== undefined) await db.run('UPDATE categories SET description = ? WHERE id = ?', [description, req.params.id]);
  if (image !== undefined) await db.run('UPDATE categories SET image = ? WHERE id = ?', [image, req.params.id]);
  if (sort_order !== undefined) await db.run('UPDATE categories SET sort_order = ? WHERE id = ?', [sort_order, req.params.id]);
  if (is_active !== undefined) await db.run('UPDATE categories SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
  res.json({ message: 'Category updated' });
});

router.delete('/categories/:id', async (req, res) => {
  const db = getDb();
  const category = await db.get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }
  const foodCount = (await db.get('SELECT COUNT(*) as count FROM food_items WHERE category_id = ?', [req.params.id]))?.count || 0;
  if (foodCount > 0) {
    return res.status(400).json({ error: `Cannot delete category with ${foodCount} food items. Move or delete items first.` });
  }
  await db.run('DELETE FROM categories WHERE id = ?', [req.params.id]);
  res.json({ message: 'Category deleted' });
});

router.get('/food-items', async (req, res) => {
  const db = getDb();
  const { search, category_id } = req.query;
  let sql = `
    SELECT f.*, c.name as category_name
    FROM food_items f
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (search) {
    sql += ' AND f.name LIKE ?';
    params.push(`%${search}%`);
  }
  if (category_id) {
    sql += ' AND f.category_id = ?';
    params.push(category_id);
  }
  sql += ' ORDER BY f.created_at DESC';
  const items = await db.all(sql, params);
  for (const item of items) {
    item.variants = await db.all('SELECT * FROM variants WHERE food_item_id = ?', [item.id]);
    item.addons = await db.all('SELECT * FROM addons WHERE food_item_id = ?', [item.id]);
  }
  res.json(items);
});

router.get('/food-items/:id', async (req, res) => {
  const db = getDb();
  const item = await db.get('SELECT * FROM food_items WHERE id = ?', [req.params.id]);
  if (!item) {
    return res.status(404).json({ error: 'Food item not found' });
  }
  item.variants = await db.all('SELECT * FROM variants WHERE food_item_id = ?', [item.id]);
  item.addons = await db.all('SELECT * FROM addons WHERE food_item_id = ?', [item.id]);
  res.json(item);
});

router.post('/food-items', async (req, res) => {
  const db = getDb();
  const {
    category_id, name, description, price, discount_price, image,
    is_veg, is_available, is_featured, is_popular, ingredients, preparation_time,
    variants, addons
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Food name is required' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Valid price is required' });

  const slug = slugify(name);
  const existing = await db.get('SELECT * FROM food_items WHERE slug = ?', [slug]);
  if (existing) {
    return res.status(400).json({ error: 'Food item with this name already exists' });
  }

  const result = await db.run(`
    INSERT INTO food_items (category_id, name, slug, description, price, discount_price, image, is_veg, is_available, is_featured, is_popular, ingredients, preparation_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    category_id || null, name.trim(), slug, description || '', price,
    discount_price || null, image || null, is_veg ? 1 : 0, is_available !== undefined ? (is_available ? 1 : 0) : 1,
    is_featured ? 1 : 0, is_popular ? 1 : 0, ingredients || '', preparation_time || 15
  ]);

  const foodId = result.lastInsertRowid;

  if (variants && Array.isArray(variants)) {
    for (const v of variants) {
      await db.run('INSERT INTO variants (food_item_id, name, price_adjustment, is_default) VALUES (?, ?, ?, ?)',
        [foodId, v.name, v.price_adjustment || 0, v.is_default ? 1 : 0]);
    }
  }

  if (addons && Array.isArray(addons)) {
    for (const a of addons) {
      await db.run('INSERT INTO addons (food_item_id, name, price, is_available) VALUES (?, ?, ?, ?)',
        [foodId, a.name, a.price || 0, a.is_available !== undefined ? (a.is_available ? 1 : 0) : 1]);
    }
  }

  res.status(201).json({ id: foodId, message: 'Food item created' });
});

router.put('/food-items/:id', async (req, res) => {
  const db = getDb();
  const item = await db.get('SELECT * FROM food_items WHERE id = ?', [req.params.id]);
  if (!item) {
    return res.status(404).json({ error: 'Food item not found' });
  }

  const {
    category_id, name, description, price, discount_price, image,
    is_veg, is_available, is_featured, is_popular, ingredients, preparation_time
  } = req.body;

  if (name && name.trim()) {
    const slug = slugify(name);
    const existing = await db.get('SELECT * FROM food_items WHERE slug = ? AND id != ?', [slug, req.params.id]);
    if (existing) {
      return res.status(400).json({ error: 'Food item with this name already exists' });
    }
    await db.run('UPDATE food_items SET name = ?, slug = ? WHERE id = ?', [name.trim(), slug, req.params.id]);
  }
  if (category_id !== undefined) await db.run('UPDATE food_items SET category_id = ? WHERE id = ?', [category_id || null, req.params.id]);
  if (description !== undefined) await db.run('UPDATE food_items SET description = ? WHERE id = ?', [description, req.params.id]);
  if (price !== undefined) await db.run('UPDATE food_items SET price = ? WHERE id = ?', [price, req.params.id]);
  if (discount_price !== undefined) await db.run('UPDATE food_items SET discount_price = ? WHERE id = ?', [discount_price || null, req.params.id]);
  if (image !== undefined) await db.run('UPDATE food_items SET image = ? WHERE id = ?', [image, req.params.id]);
  if (is_veg !== undefined) await db.run('UPDATE food_items SET is_veg = ? WHERE id = ?', [is_veg ? 1 : 0, req.params.id]);
  if (is_available !== undefined) await db.run('UPDATE food_items SET is_available = ? WHERE id = ?', [is_available ? 1 : 0, req.params.id]);
  if (is_featured !== undefined) await db.run('UPDATE food_items SET is_featured = ? WHERE id = ?', [is_featured ? 1 : 0, req.params.id]);
  if (is_popular !== undefined) await db.run('UPDATE food_items SET is_popular = ? WHERE id = ?', [is_popular ? 1 : 0, req.params.id]);
  if (ingredients !== undefined) await db.run('UPDATE food_items SET ingredients = ? WHERE id = ?', [ingredients, req.params.id]);
  if (preparation_time !== undefined) await db.run('UPDATE food_items SET preparation_time = ? WHERE id = ?', [preparation_time, req.params.id]);
  await db.run("UPDATE food_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);

  res.json({ message: 'Food item updated' });
});

router.delete('/food-items/:id', async (req, res) => {
  const db = getDb();
  const item = await db.get('SELECT * FROM food_items WHERE id = ?', [req.params.id]);
  if (!item) {
    return res.status(404).json({ error: 'Food item not found' });
  }
  await db.run('DELETE FROM food_items WHERE id = ?', [req.params.id]);
  res.json({ message: 'Food item deleted' });
});

router.post('/food-items/:id/variants', async (req, res) => {
  const db = getDb();
  const { name, price_adjustment, is_default } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Variant name is required' });
  const result = await db.run('INSERT INTO variants (food_item_id, name, price_adjustment, is_default) VALUES (?, ?, ?, ?)',
    [req.params.id, name.trim(), price_adjustment || 0, is_default ? 1 : 0]);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Variant added' });
});

router.put('/variants/:id', async (req, res) => {
  const db = getDb();
  const { name, price_adjustment, is_default } = req.body;
  const variant = await db.get('SELECT * FROM variants WHERE id = ?', [req.params.id]);
  if (!variant) return res.status(404).json({ error: 'Variant not found' });
  if (name !== undefined) await db.run('UPDATE variants SET name = ? WHERE id = ?', [name, req.params.id]);
  if (price_adjustment !== undefined) await db.run('UPDATE variants SET price_adjustment = ? WHERE id = ?', [price_adjustment, req.params.id]);
  if (is_default !== undefined) await db.run('UPDATE variants SET is_default = ? WHERE id = ?', [is_default ? 1 : 0, req.params.id]);
  res.json({ message: 'Variant updated' });
});

router.delete('/variants/:id', async (req, res) => {
  const db = getDb();
  await db.run('DELETE FROM variants WHERE id = ?', [req.params.id]);
  res.json({ message: 'Variant deleted' });
});

router.post('/food-items/:id/addons', async (req, res) => {
  const db = getDb();
  const { name, price, is_available } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Addon name is required' });
  const result = await db.run('INSERT INTO addons (food_item_id, name, price, is_available) VALUES (?, ?, ?, ?)',
    [req.params.id, name.trim(), price || 0, is_available !== undefined ? (is_available ? 1 : 0) : 1]);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Addon added' });
});

router.put('/addons/:id', async (req, res) => {
  const db = getDb();
  const { name, price, is_available } = req.body;
  const addon = await db.get('SELECT * FROM addons WHERE id = ?', [req.params.id]);
  if (!addon) return res.status(404).json({ error: 'Addon not found' });
  if (name !== undefined) await db.run('UPDATE addons SET name = ? WHERE id = ?', [name, req.params.id]);
  if (price !== undefined) await db.run('UPDATE addons SET price = ? WHERE id = ?', [price, req.params.id]);
  if (is_available !== undefined) await db.run('UPDATE addons SET is_available = ? WHERE id = ?', [is_available ? 1 : 0, req.params.id]);
  res.json({ message: 'Addon updated' });
});

router.delete('/addons/:id', async (req, res) => {
  const db = getDb();
  await db.run('DELETE FROM addons WHERE id = ?', [req.params.id]);
  res.json({ message: 'Addon deleted' });
});

router.get('/orders', async (req, res) => {
  const db = getDb();
  const { status, search, payment_status, date_from, date_to, include_deleted } = req.query;
  let sql = `
    SELECT o.*, dp.name as delivery_person_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
    FROM orders o
    LEFT JOIN delivery_persons dp ON o.delivery_person_id = dp.id
    WHERE 1=1
  `;
  const params = [];
  if (!include_deleted) {
    sql += ' AND o.is_deleted != 1';
  }
  if (status) {
    sql += ' AND o.order_status = ?';
    params.push(status);
  }
  if (payment_status) {
    sql += ' AND o.payment_status = ?';
    params.push(payment_status);
  }
  if (search) {
    sql += ' AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  if (date_from) {
    sql += ' AND DATE(o.created_at) >= ?';
    params.push(date_from);
  }
  if (date_to) {
    sql += ' AND DATE(o.created_at) <= ?';
    params.push(date_to);
  }
  sql += ' ORDER BY o.created_at DESC';
  res.json(await db.all(sql, params));
});

router.get('/orders/trash', async (req, res) => {
  const db = getDb();
  const { search } = req.query;
  let sql = `SELECT o.*, dp.name as delivery_person_name,
    (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
    FROM orders o
    LEFT JOIN delivery_persons dp ON o.delivery_person_id = dp.id
    WHERE o.is_deleted = 1
    ORDER BY o.deleted_at DESC`;
  const params = [];
  if (search) {
    sql += ' AND (o.order_number LIKE ? OR o.tracking_id LIKE ? OR o.customer_name LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  res.json(await db.all(sql, params));
});

router.delete('/orders/trash/clear', async (req, res) => {
  const db = getDb();
  const result = await db.run('DELETE FROM orders WHERE is_deleted = 1');
  res.json({ message: `${result.changes} permanently deleted order(s) from trash` });
});

router.get('/orders/:id', async (req, res) => {
  const db = getDb();
  const order = await db.get(`
    SELECT o.*, dp.name as delivery_person_name, dp.phone as delivery_person_phone
    FROM orders o
    LEFT JOIN delivery_persons dp ON o.delivery_person_id = dp.id
    WHERE o.id = ? AND o.is_deleted != 1
  `, [req.params.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  order.items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  order.items.forEach(item => {
    item.addons = item.addons_json ? JSON.parse(item.addons_json) : [];
  });
  order.status_history = await db.all('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC', [order.id]);
  order.payment = await db.get('SELECT * FROM payments WHERE order_id = ?', [order.id]);
  order.customer = await db.get('SELECT * FROM customers WHERE id = ?', [order.customer_id]);
  res.json(order);
});

router.put('/orders/:id/status', async (req, res) => {
  const db = getDb();
  const { status, note } = req.body;
  const validStatuses = ['pending', 'payment_pending', 'payment_verification', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid order status' });
  }
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order || order.is_deleted === 1) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (order.order_status === 'cancelled' && status !== 'cancelled') {
    return res.status(400).json({ error: 'Cannot change status of a cancelled order' });
  }
  if (order.order_status === 'delivered' && status !== 'delivered') {
    return res.status(400).json({ error: 'Cannot change status of a delivered order' });
  }

  await db.run('UPDATE orders SET order_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id]);
  await addOrderStatusHistory(req.params.id, status, note || '');

  const statusLabels = {
    pending: 'Pending',
    payment_pending: 'Payment Pending',
    payment_verification: 'Payment Verification',
    accepted: 'Accepted',
    preparing: 'Preparing',
    ready: 'Ready',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    rejected: 'Rejected'
  };

  await createNotification('order_status', `Order ${order.order_number} ${statusLabels[status]}`, `Order ${order.order_number} status updated to ${statusLabels[status]}`, 'admin', order.id);
  await createNotification('order_status', `Your order ${order.order_number} is ${statusLabels[status]}`, `Order ${order.order_number} status: ${statusLabels[status]}`, 'customer', order.id);

  res.json({ message: 'Order status updated' });
});

router.put('/orders/:id/payment-status', async (req, res) => {
  const db = getDb();
  const { payment_status, transaction_id, rejection_reason } = req.body;
  const validStatuses = ['pending', 'payment_submitted', 'verified', 'failed', 'rejected', 'refunded'];
  if (!validStatuses.includes(payment_status)) {
    return res.status(400).json({ error: 'Invalid payment status' });
  }
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order || order.is_deleted === 1) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const orderUpdates = ['payment_status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const orderParams = [payment_status];
  if (transaction_id) {
    orderUpdates.push('transaction_id = ?');
    orderParams.push(transaction_id);
  }
  orderParams.push(req.params.id);
  await db.run(`UPDATE orders SET ${orderUpdates.join(', ')} WHERE id = ?`, orderParams);

  const paymentUpdates = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const paymentParams = [payment_status];
  if (transaction_id) {
    paymentUpdates.push('transaction_id = ?');
    paymentParams.push(transaction_id);
  }
  if (rejection_reason) {
    paymentUpdates.push('rejection_reason = ?');
    paymentParams.push(rejection_reason);
  }
  if (payment_status === 'verified') {
    paymentUpdates.push('verified_by = ?', 'verified_at = CURRENT_TIMESTAMP');
    paymentParams.push(req.user.id, order.id);
  } else {
    paymentParams.push(order.id);
  }
  await db.run(`UPDATE payments SET ${paymentUpdates.join(', ')} WHERE order_id = ?`, paymentParams);

  if (payment_status === 'verified') {
    await createNotification('payment', `Payment Verified for ${order.order_number}`, `Payment of ₹${order.grand_total.toFixed(2)} verified`, 'admin', order.id);
    await createNotification('payment', `Payment Verified for Order ${order.order_number}`, `Your payment for order ${order.order_number} has been verified. We will start preparing your order soon.`, 'customer', order.id);
  } else if (payment_status === 'rejected') {
    await createNotification('payment', `Payment Rejected for ${order.order_number}`, `Payment for order ${order.order_number} was rejected`, 'admin', order.id);
    await createNotification('payment', `Payment Rejected for Order ${order.order_number}`, `Your payment for order ${order.order_number} was rejected. Please contact support or submit payment again.`, 'customer', order.id);
  }

  res.json({ message: 'Payment status updated' });
});

router.put('/orders/:id/assign-delivery', async (req, res) => {
  const db = getDb();
  const { delivery_person_id } = req.body;
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order || order.is_deleted === 1) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (delivery_person_id) {
    const dp = await db.get('SELECT * FROM delivery_persons WHERE id = ? AND is_active = 1', [delivery_person_id]);
    if (!dp) {
      return res.status(400).json({ error: 'Delivery person not found or inactive' });
    }
  }
  await db.run('UPDATE orders SET delivery_person_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [delivery_person_id || null, req.params.id]);
  if (delivery_person_id) {
    const dp = await db.get('SELECT name FROM delivery_persons WHERE id = ?', [delivery_person_id]);
    await addOrderStatusHistory(req.params.id, order.order_status, `Assigned to ${dp.name}`);
  }
  res.json({ message: 'Delivery person assigned' });
});

router.post('/orders/bulk-delete', async (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No order IDs provided' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const orderIds = (await db.all(
    `SELECT id FROM orders WHERE id IN (${placeholders}) AND is_deleted != 1`,
    ids
  )).map(r => r.id);

  if (orderIds.length === 0) {
    return res.status(404).json({ error: 'No valid orders found to delete' });
  }

  const updatePlaceholders = orderIds.map(() => '?').join(',');
  await db.run(
    `UPDATE orders SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id IN (${updatePlaceholders})`,
    [req.user.id, ...orderIds]
  );

  for (const id of orderIds) {
    const order = await db.get('SELECT order_status FROM orders WHERE id = ?', [id]);
    await addOrderStatusHistory(id, order?.order_status || 'received', 'Order moved to trash (bulk)');
  }

  res.json({ message: `${orderIds.length} order(s) moved to trash` });
});

router.put('/orders/:id/restore', async (req, res) => {
  const db = getDb();
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND is_deleted = 1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Deleted order not found' });

  await db.run('UPDATE orders SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE id = ?', [req.params.id]);
  await addOrderStatusHistory(req.params.id, order.order_status, 'Order restored from trash');
  res.json({ message: 'Order restored successfully' });
});

router.delete('/orders/:id', async (req, res) => {
  const db = getDb();
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.is_deleted === 1) {
    await db.run('DELETE FROM orders WHERE id = ?', [req.params.id]);
    res.json({ message: 'Order permanently deleted', permanent: true });
  } else {
    await db.run('UPDATE orders SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?',
      [req.user.id, req.params.id]);
    await addOrderStatusHistory(req.params.id, order.order_status, 'Order moved to trash');
    res.json({ message: 'Order moved to trash', permanent: false });
  }
});

router.get('/delivery-persons', async (req, res) => {
  const db = getDb();
  const persons = await db.all(`
    SELECT dp.*,
      (SELECT COUNT(*) FROM orders o WHERE o.delivery_person_id = dp.id AND o.order_status IN ('received', 'confirmed', 'preparing', 'ready', 'out_for_delivery')) as active_orders
    FROM delivery_persons dp
    ORDER BY dp.created_at DESC
  `);
  res.json(persons);
});

router.post('/delivery-persons', async (req, res) => {
  const db = getDb();
  const { name, phone, email, vehicle_type, is_active } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Phone is required' });
  const result = await db.run('INSERT INTO delivery_persons (name, phone, email, vehicle_type, is_active) VALUES (?, ?, ?, ?, ?)',
    [name.trim(), phone.trim(), email || '', vehicle_type || '', is_active !== undefined ? (is_active ? 1 : 0) : 1]);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Delivery person added' });
});

router.put('/delivery-persons/:id', async (req, res) => {
  const db = getDb();
  const { name, phone, email, vehicle_type, is_active } = req.body;
  const dp = await db.get('SELECT * FROM delivery_persons WHERE id = ?', [req.params.id]);
  if (!dp) return res.status(404).json({ error: 'Delivery person not found' });
  if (name !== undefined) await db.run('UPDATE delivery_persons SET name = ? WHERE id = ?', [name, req.params.id]);
  if (phone !== undefined) await db.run('UPDATE delivery_persons SET phone = ? WHERE id = ?', [phone, req.params.id]);
  if (email !== undefined) await db.run('UPDATE delivery_persons SET email = ? WHERE id = ?', [email, req.params.id]);
  if (vehicle_type !== undefined) await db.run('UPDATE delivery_persons SET vehicle_type = ? WHERE id = ?', [vehicle_type, req.params.id]);
  if (is_active !== undefined) await db.run('UPDATE delivery_persons SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
  res.json({ message: 'Delivery person updated' });
});

router.delete('/delivery-persons/:id', async (req, res) => {
  const db = getDb();
  const activeOrders = (await db.get("SELECT COUNT(*) as count FROM orders WHERE delivery_person_id = ? AND order_status NOT IN ('delivered', 'cancelled')", [req.params.id]))?.count || 0;
  if (activeOrders > 0) {
    return res.status(400).json({ error: `Cannot delete delivery person with ${activeOrders} active orders` });
  }
  await db.run('DELETE FROM delivery_persons WHERE id = ?', [req.params.id]);
  res.json({ message: 'Delivery person deleted' });
});

router.get('/customers', async (req, res) => {
  const db = getDb();
  const { search, include_deleted } = req.query;
  let sql = `
    SELECT c.*,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.is_deleted != 1) as total_orders,
      (SELECT COALESCE(SUM(o.grand_total), 0) FROM orders o WHERE o.customer_id = c.id AND o.order_status != 'cancelled' AND o.is_deleted != 1) as total_spent,
      (SELECT COUNT(*) FROM reviews r WHERE r.customer_phone = c.phone) as total_reviews
    FROM customers c
    WHERE 1=1
  `;
  const params = [];
  if (!include_deleted) {
    sql += ' AND c.is_deleted != 1';
  }
  if (search) {
    sql += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term);
  }
  sql += ' ORDER BY c.created_at DESC';
  res.json(await db.all(sql, params));
});

router.post('/customers/bulk-delete', async (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No customer IDs provided' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const validIds = (await db.all(`SELECT id FROM customers WHERE id IN (${placeholders}) AND is_deleted != 1`, ids)).map(r => r.id);
  if (validIds.length === 0) {
    return res.status(404).json({ error: 'No valid customers found to delete' });
  }
  const updatePlaceholders = validIds.map(() => '?').join(',');
  await db.run(`UPDATE customers SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id IN (${updatePlaceholders})`, [req.user.id, ...validIds]);
  res.json({ message: `${validIds.length} customer(s) moved to trash` });
});

router.get('/customers/trash', async (req, res) => {
  const db = getDb();
  const { search } = req.query;
  let sql = 'SELECT * FROM customers WHERE is_deleted = 1';
  const params = [];
  if (search) {
    sql += ' AND (name LIKE ? OR phone LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term);
  }
  sql += ' ORDER BY deleted_at DESC';
  res.json(await db.all(sql, params));
});

router.delete('/customers/trash/clear', async (req, res) => {
  const db = getDb();
  const result = await db.run('DELETE FROM customers WHERE is_deleted = 1');
  res.json({ message: `${result.changes} permanently deleted customer(s) from trash` });
});

router.get('/customers/:id', async (req, res) => {
  const db = getDb();
  const { include_deleted } = req.query;
  let sql = 'SELECT * FROM customers WHERE id = ?';
  if (!include_deleted) sql += ' AND is_deleted != 1';
  const customer = await db.get(sql, [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  customer.orders = await db.all('SELECT * FROM orders WHERE customer_id = ? AND is_deleted != 1 ORDER BY created_at DESC', [customer.id]);
  customer.reviews = await db.all('SELECT * FROM reviews WHERE customer_phone = ?', [customer.phone]);
  res.json(customer);
});

router.delete('/customers/:id', async (req, res) => {
  const db = getDb();
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  if (customer.is_deleted === 1) {
    await db.run('DELETE FROM customers WHERE id = ?', [req.params.id]);
    res.json({ message: 'Customer permanently deleted', permanent: true });
  } else {
    await db.run('UPDATE customers SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?', [req.user.id, req.params.id]);
    res.json({ message: 'Customer moved to trash', permanent: false });
  }
});

router.put('/customers/:id/restore', async (req, res) => {
  const db = getDb();
  const customer = await db.get('SELECT * FROM customers WHERE id = ? AND is_deleted = 1', [req.params.id]);
  if (!customer) return res.status(404).json({ error: 'Deleted customer not found' });
  await db.run('UPDATE customers SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE id = ?', [req.params.id]);
  res.json({ message: 'Customer restored successfully' });
});

router.get('/coupons', async (req, res) => {
  const db = getDb();
  res.json(await db.all('SELECT * FROM coupons ORDER BY created_at DESC'));
});

router.post('/coupons', async (req, res) => {
  const db = getDb();
  const { code, description, discount_type, discount_value, min_order_value, max_discount, expiry_date, usage_limit, is_active } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'Coupon code is required' });
  if (!discount_type || !['percentage', 'fixed'].includes(discount_type)) return res.status(400).json({ error: 'Invalid discount type' });
  if (!discount_value || discount_value <= 0) return res.status(400).json({ error: 'Valid discount value is required' });
  if (discount_type === 'percentage' && discount_value > 100) return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });

  const existing = await db.get('SELECT * FROM coupons WHERE code = ?', [code.trim().toUpperCase()]);
  if (existing) return res.status(400).json({ error: 'Coupon code already exists' });

  const result = await db.run('INSERT INTO coupons (code, description, discount_type, discount_value, min_order_value, max_discount, expiry_date, usage_limit, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [code.trim().toUpperCase(), description || '', discount_type, discount_value, min_order_value || 0, max_discount || null, expiry_date || null, usage_limit || null, is_active !== undefined ? (is_active ? 1 : 0) : 1]);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Coupon created' });
});

router.put('/coupons/:id', async (req, res) => {
  const db = getDb();
  const coupon = await db.get('SELECT * FROM coupons WHERE id = ?', [req.params.id]);
  if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
  const { code, description, discount_type, discount_value, min_order_value, max_discount, expiry_date, usage_limit, is_active } = req.body;
  if (code) {
    const existing = await db.get('SELECT * FROM coupons WHERE code = ? AND id != ?', [code.trim().toUpperCase(), req.params.id]);
    if (existing) return res.status(400).json({ error: 'Coupon code already exists' });
    await db.run('UPDATE coupons SET code = ? WHERE id = ?', [code.trim().toUpperCase(), req.params.id]);
  }
  if (description !== undefined) await db.run('UPDATE coupons SET description = ? WHERE id = ?', [description, req.params.id]);
  if (discount_type !== undefined) await db.run('UPDATE coupons SET discount_type = ? WHERE id = ?', [discount_type, req.params.id]);
  if (discount_value !== undefined) await db.run('UPDATE coupons SET discount_value = ? WHERE id = ?', [discount_value, req.params.id]);
  if (min_order_value !== undefined) await db.run('UPDATE coupons SET min_order_value = ? WHERE id = ?', [min_order_value || 0, req.params.id]);
  if (max_discount !== undefined) await db.run('UPDATE coupons SET max_discount = ? WHERE id = ?', [max_discount || null, req.params.id]);
  if (expiry_date !== undefined) await db.run('UPDATE coupons SET expiry_date = ? WHERE id = ?', [expiry_date || null, req.params.id]);
  if (usage_limit !== undefined) await db.run('UPDATE coupons SET usage_limit = ? WHERE id = ?', [usage_limit || null, req.params.id]);
  if (is_active !== undefined) await db.run('UPDATE coupons SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
  res.json({ message: 'Coupon updated' });
});

router.delete('/coupons/:id', async (req, res) => {
  const db = getDb();
  await db.run('DELETE FROM coupons WHERE id = ?', [req.params.id]);
  res.json({ message: 'Coupon deleted' });
});

router.get('/reviews', async (req, res) => {
  const db = getDb();
  const { status } = req.query;
  let sql = 'SELECT * FROM reviews WHERE 1=1';
  const params = [];
  if (status === 'pending') {
    sql += ' AND is_approved = 0';
  } else if (status === 'approved') {
    sql += ' AND is_approved = 1';
  }
  sql += ' ORDER BY created_at DESC';
  res.json(await db.all(sql, params));
});

router.put('/reviews/:id/approve', async (req, res) => {
  const db = getDb();
  const { approve, is_featured } = req.body;
  const review = await db.get('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (approve !== undefined) await db.run('UPDATE reviews SET is_approved = ? WHERE id = ?', [approve ? 1 : 0, req.params.id]);
  if (is_featured !== undefined) await db.run('UPDATE reviews SET is_featured = ? WHERE id = ?', [is_featured ? 1 : 0, req.params.id]);
  res.json({ message: 'Review updated' });
});

router.delete('/reviews/:id', async (req, res) => {
  const db = getDb();
  await db.run('DELETE FROM reviews WHERE id = ?', [req.params.id]);
  res.json({ message: 'Review deleted' });
});

router.get('/settings', async (req, res) => {
  const db = getDb();
  const settings = await db.get('SELECT * FROM restaurant_settings WHERE id = 1');
  const homepage = await db.get('SELECT * FROM homepage_content WHERE id = 1');
  res.json({ settings, homepage });
});

router.put('/settings/restaurant', async (req, res) => {
  const db = getDb();
  const fields = ['name', 'logo', 'tagline', 'description', 'address', 'phone', 'email', 'opening_time', 'closing_time', 'is_open', 'manual_status', 'allow_ordering_when_closed', 'currency'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(1);
  await db.run(`UPDATE restaurant_settings SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: 'Restaurant settings updated' });
});

router.put('/settings/delivery', async (req, res) => {
  const db = getDb();
  const fields = ['delivery_charge', 'min_order_value', 'delivery_radius_km'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(1);
  await db.run(`UPDATE restaurant_settings SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: 'Delivery settings updated' });
});

router.put('/settings/payment', async (req, res) => {
  const db = getDb();
  const fields = [
    'tax_rate', 'payment_gateway', 'payment_gateway_key', 'payment_gateway_secret', 'upi_id',
    'payment_upi_enabled', 'payment_upi_name',
    'payment_qr_enabled', 'payment_qr_image',
    'payment_bank_enabled', 'payment_bank_holder', 'payment_bank_name', 'payment_bank_account', 'payment_bank_ifsc', 'payment_bank_branch',
    'payment_direct_enabled', 'payment_direct_number', 'payment_direct_name'
  ];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(1);
  await db.run(`UPDATE restaurant_settings SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: 'Payment settings updated' });
});

router.put('/settings/social', async (req, res) => {
  const db = getDb();
  const fields = ['facebook', 'instagram', 'twitter', 'youtube'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(1);
  await db.run(`UPDATE restaurant_settings SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: 'Social links updated' });
});

router.put('/homepage', async (req, res) => {
  const db = getDb();
  const fields = ['hero_title', 'hero_subtitle', 'hero_description', 'hero_image', 'hero_button_text', 'hero_button_link', 'about_title', 'about_description', 'about_image', 'offer_title', 'offer_description', 'offer_image', 'footer_about', 'footer_copyright'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(1);
  await db.run(`UPDATE homepage_content SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: 'Homepage content updated' });
});

router.get('/notifications', async (req, res) => {
  const db = getDb();
  res.json(await db.all("SELECT * FROM notifications WHERE recipient_type = 'admin' ORDER BY created_at DESC LIMIT 50"));
});

router.put('/notifications/:id/read', async (req, res) => {
  const db = getDb();
  await db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
  res.json({ message: 'Notification marked as read' });
});

router.put('/notifications/read-all', async (req, res) => {
  const db = getDb();
  await db.run("UPDATE notifications SET is_read = 1 WHERE recipient_type = 'admin'");
  res.json({ message: 'All notifications marked as read' });
});

router.get('/analytics', async (req, res) => {
  const db = getDb();
  const { period, date_from, date_to } = req.query;

  let dateFilter = '';
  const params = [];

  if (date_from && date_to) {
    dateFilter = ' AND DATE(o.created_at) BETWEEN ? AND ?';
    params.push(date_from, date_to);
  } else if (period === 'daily') {
    dateFilter = " AND DATE(o.created_at) = CURRENT_DATE";
  } else if (period === 'weekly') {
    dateFilter = " AND DATE(o.created_at) >= CURRENT_DATE - INTERVAL '7 days'";
  } else if (period === 'monthly') {
    dateFilter = " AND DATE(o.created_at) >= CURRENT_DATE - INTERVAL '30 days'";
  }

  const dailySales = await db.all(`
    SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
    FROM orders o
    WHERE order_status != 'cancelled' AND DATE(created_at) >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at) ASC
  `);

  const summary = await db.get(`
    SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(CASE WHEN order_status != 'cancelled' THEN grand_total ELSE 0 END), 0) as total_revenue,
      COALESCE(AVG(CASE WHEN order_status != 'cancelled' THEN grand_total END), 0) as avg_order_value,
      SUM(CASE WHEN order_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
      SUM(CASE WHEN order_status = 'delivered' THEN 1 ELSE 0 END) as completed_orders
    FROM orders o
    WHERE 1=1 ${dateFilter}
  `, params);

  const popularItems = await db.all(`
    SELECT oi.food_name, SUM(oi.quantity) as total_quantity, COUNT(DISTINCT oi.order_id) as order_count, SUM(oi.item_total) as revenue
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.order_status != 'cancelled' ${dateFilter}
    GROUP BY oi.food_name
    ORDER BY total_quantity DESC
    LIMIT 10
  `, params);

  const popularCoupons = await db.all(`
    SELECT coupon_code, COUNT(*) as usage_count, SUM(coupon_discount) as total_discount
    FROM orders o
    WHERE coupon_code IS NOT NULL ${dateFilter}
    GROUP BY coupon_code
    ORDER BY usage_count DESC
    LIMIT 5
  `, params);

  const ordersByStatus = await db.all(`
    SELECT order_status, COUNT(*) as count
    FROM orders o
    WHERE 1=1 ${dateFilter}
    GROUP BY order_status
  `, params);

  const paymentMethods = await db.all(`
    SELECT payment_method, COUNT(*) as count, COALESCE(SUM(grand_total), 0) as revenue
    FROM orders o
    WHERE 1=1 ${dateFilter}
    GROUP BY payment_method
  `, params);

  res.json({
    daily_sales: dailySales,
    summary,
    popular_items: popularItems,
    popular_coupons: popularCoupons,
    orders_by_status: ordersByStatus,
    payment_methods: paymentMethods
  });
});

router.get('/promotions', async (req, res) => {
  const db = getDb();
  const { status } = req.query;
  let sql = 'SELECT * FROM promotions WHERE 1=1';
  const params = [];
  if (status === 'active') {
    sql += ' AND is_active = 1 AND (end_date IS NULL OR end_date > CURRENT_TIMESTAMP)';
  } else if (status === 'inactive') {
    sql += ' AND is_active = 0';
  } else if (status === 'expired') {
    sql += ' AND end_date IS NOT NULL AND end_date <= CURRENT_TIMESTAMP';
  }
  sql += ' ORDER BY priority DESC, created_at DESC';
  const promotions = await db.all(sql, params);
  promotions.forEach(p => {
    try { p.products = p.products ? JSON.parse(p.products) : []; } catch(e) { p.products = []; }
    try { p.categories = p.categories ? JSON.parse(p.categories) : []; } catch(e) { p.categories = []; }
  });
  res.json(promotions);
});

router.get('/promotions/:id', async (req, res) => {
  const db = getDb();
  const promotion = await db.get('SELECT * FROM promotions WHERE id = ?', [req.params.id]);
  if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
  try { promotion.products = promotion.products ? JSON.parse(promotion.products) : []; } catch(e) { promotion.products = []; }
  try { promotion.categories = promotion.categories ? JSON.parse(promotion.categories) : []; } catch(e) { promotion.categories = []; }
  res.json(promotion);
});

router.post('/promotions', async (req, res) => {
  const db = getDb();
  const {
    name, description, discount_type, discount_value, scope,
    products, categories, min_order_value, max_discount,
    start_date, end_date, is_active, usage_limit, priority, allow_stacking
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Promotion name is required' });
  if (!discount_type || !['percentage', 'fixed'].includes(discount_type)) {
    return res.status(400).json({ error: 'Invalid discount type' });
  }
  if (!discount_value || discount_value <= 0) {
    return res.status(400).json({ error: 'Valid discount value is required' });
  }
  if (discount_type === 'percentage' && discount_value > 100) {
    return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });
  }
  if (!scope || !['all_products', 'category', 'product'].includes(scope)) {
    return res.status(400).json({ error: 'Invalid scope' });
  }

  if (scope === 'category' && categories && categories.length) {
    const validCategories = await db.all(`SELECT id FROM categories WHERE id IN (${categories.map(() => '?').join(',')})`, categories);
    const validIds = validCategories.map(c => c.id);
    const invalid = categories.filter(c => !validIds.includes(typeof c === 'string' ? parseInt(c) : c));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid category IDs: ${invalid.join(', ')}` });
    }
  }

  if (scope === 'product' && products && products.length) {
    const validProducts = await db.all(`SELECT id FROM food_items WHERE id IN (${products.map(() => '?').join(',')})`, products);
    const validIds = validProducts.map(p => p.id);
    const invalid = products.filter(p => !validIds.includes(typeof p === 'string' ? parseInt(p) : p));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid product IDs: ${invalid.join(', ')}` });
    }
  }

  const result = await db.run(`
    INSERT INTO promotions (
      name, description, discount_type, discount_value, scope,
      products, categories, min_order_value, max_discount,
      start_date, end_date, is_active, usage_limit, priority, allow_stacking
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    name.trim(), description || '', discount_type, discount_value, scope,
    JSON.stringify(products || []), JSON.stringify(categories || []),
    min_order_value || 0, max_discount || null,
    start_date || null, end_date || null,
    is_active !== undefined ? (is_active ? 1 : 0) : 1,
    usage_limit || null, priority || 0,
    allow_stacking ? 1 : 0
  ]);

  res.status(201).json({ id: result.lastInsertRowid, message: 'Promotion created' });
});

router.put('/promotions/:id', async (req, res) => {
  const db = getDb();
  const promotion = await db.get('SELECT * FROM promotions WHERE id = ?', [req.params.id]);
  if (!promotion) return res.status(404).json({ error: 'Promotion not found' });

  const {
    name, description, discount_type, discount_value, scope,
    products, categories, min_order_value, max_discount,
    start_date, end_date, is_active, usage_limit, priority, allow_stacking
  } = req.body;

  const updates = {};
  const params = [];

  if (name !== undefined) { updates.name = name.trim(); }
  if (description !== undefined) { updates.description = description; }
  if (discount_type !== undefined) { updates.discount_type = discount_type; }
  if (discount_value !== undefined) { updates.discount_value = discount_value; }
  if (scope !== undefined) { updates.scope = scope; }
  if (products !== undefined) {
    if (scope === 'product' && products.length) {
      const validProducts = await db.all(`SELECT id FROM food_items WHERE id IN (${products.map(() => '?').join(',')})`, products);
      const validIds = validProducts.map(p => p.id);
      const invalid = products.filter(p => !validIds.includes(typeof p === 'string' ? parseInt(p) : p));
      if (invalid.length) {
        return res.status(400).json({ error: `Invalid product IDs: ${invalid.join(', ')}` });
      }
    }
    updates.products = JSON.stringify(products);
  }
  if (categories !== undefined) {
    if (scope === 'category' && categories.length) {
      const validCategories = await db.all(`SELECT id FROM categories WHERE id IN (${categories.map(() => '?').join(',')})`, categories);
      const validIds = validCategories.map(c => c.id);
      const invalid = categories.filter(c => !validIds.includes(typeof c === 'string' ? parseInt(c) : c));
      if (invalid.length) {
        return res.status(400).json({ error: `Invalid category IDs: ${invalid.join(', ')}` });
      }
    }
    updates.categories = JSON.stringify(categories);
  }
  if (min_order_value !== undefined) { updates.min_order_value = min_order_value; }
  if (max_discount !== undefined) { updates.max_discount = max_discount; }
  if (start_date !== undefined) { updates.start_date = start_date; }
  if (end_date !== undefined) { updates.end_date = end_date; }
  if (is_active !== undefined) { updates.is_active = is_active ? 1 : 0; }
  if (usage_limit !== undefined) { updates.usage_limit = usage_limit; }
  if (priority !== undefined) { updates.priority = priority; }
  if (allow_stacking !== undefined) { updates.allow_stacking = allow_stacking ? 1 : 0; }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(req.params.id);

  await db.run(`UPDATE promotions SET ${setClause} WHERE id = ?`, values);
  res.json({ message: 'Promotion updated' });
});

router.delete('/promotions/:id', async (req, res) => {
  const db = getDb();
  const promotion = await db.get('SELECT * FROM promotions WHERE id = ?', [req.params.id]);
  if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
  await db.run('DELETE FROM promotions WHERE id = ?', [req.params.id]);
  res.json({ message: 'Promotion deleted' });
});

router.put('/promotions/:id/toggle', async (req, res) => {
  const db = getDb();
  const promotion = await db.get('SELECT * FROM promotions WHERE id = ?', [req.params.id]);
  if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
  await db.run('UPDATE promotions SET is_active = ? WHERE id = ?', [promotion.is_active ? 0 : 1, req.params.id]);
  res.json({ message: `Promotion ${promotion.is_active ? 'deactivated' : 'activated'}` });
});

module.exports = router;
