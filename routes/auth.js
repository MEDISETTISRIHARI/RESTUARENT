const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { signToken } = require('../middleware/auth');

// ============ ADMIN LOGIN ============
router.post('/login', (req, res) => {
  const db = getDb();
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.get(
    'SELECT * FROM admin_users WHERE username = ? OR email = ?',
    [username.trim(), username.trim()]
  );

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, role: user.role }
  });
});

// ============ FORGOT PASSWORD ============
// In production, this would send a reset email with a token.
// Here we provide the structure for password reset.
router.post('/forgot-password', (req, res) => {
  const db = getDb();
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = db.get('SELECT * FROM admin_users WHERE email = ?', [email.trim()]);
  if (!user) {
    // Don't reveal whether the email exists
    return res.json({ message: 'If the email exists, a reset link has been sent.' });
  }

  // In production: generate a reset token, store it, and email the link.
  // For this local setup, we return a structured response indicating where to configure email.
  res.json({
    message: 'If the email exists, a reset link has been sent.',
    // NOTE: In production, remove the debug_token field and send via email/SMS.
    // The reset token would be stored in a password_resets table with expiry.
    debug_token: 'reset-token-placeholder'
  });
});

// ============ RESET PASSWORD ============
router.post('/reset-password', (req, res) => {
  const db = getDb();
  const { token, email, new_password } = req.body;

  if (!token || !email || !new_password) {
    return res.status(400).json({ error: 'Token, email and new password are required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // In production: verify the token from the password_resets table
  // For this local setup, the debug_token from forgot-password is accepted.
  const user = db.get('SELECT * FROM admin_users WHERE email = ?', [email.trim()]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, user.id]);
  res.json({ message: 'Password reset successfully. You can now login.' });
});

module.exports = router;