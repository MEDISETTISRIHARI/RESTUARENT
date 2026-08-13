const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'restaurant-platform-secret-key-change-in-production';
const JWT_EXPIRY = '24h';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const db = getDb();
  const user = db.get('SELECT id, username, email, role FROM admin_users WHERE id = ?', [decoded.id]);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

function signCustomerToken(customer) {
  return jwt.sign(
    { id: customer.id, name: customer.name, phone: customer.phone, role: 'customer' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyCustomerToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireCustomer(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Customer authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyCustomerToken(token);
  if (!decoded || decoded.role !== 'customer') {
    return res.status(401).json({ error: 'Invalid or expired customer token' });
  }
  const db = getDb();
  const customer = db.get('SELECT id, name, phone, email FROM customers WHERE id = ?', [decoded.id]);
  if (!customer) {
    return res.status(401).json({ error: 'Customer not found' });
  }
  req.customer = customer;
  next();
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, signCustomerToken, verifyCustomerToken, requireCustomer, JWT_SECRET };