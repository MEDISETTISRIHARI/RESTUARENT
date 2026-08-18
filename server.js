const express = require('express');
const cors = require('cors');
const path = require('path');

const { init, getDb, wrapDb, isPostgres } = require('./db/database');
const { isStorageConfigured } = require('./utils/storage');
const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const promotionRoutes = require('./routes/promotions');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

app.use('/api/auth', authRoutes);
app.use('/api', publicRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/menu', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/offers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/cart', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/payment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/my-orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/track-order', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/food/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((err, req, res, next) => {
  console.error('Error:', err.message, err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

init().then(() => {
  wrapDb();

  const storageMode = isStorageConfigured() ? 'S3/R2 persistent storage' : 'local filesystem fallback';
  const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  console.log(`\n📦 Image Storage: ${storageMode} (${env})`);
  if (!isStorageConfigured() && process.env.NODE_ENV === 'production') {
    console.warn('⚠️  WARNING: Running in production WITHOUT persistent image storage configured.');
    console.warn('   Uploads will FAIL until STORAGE_BACKEND and S3_* environment variables are set.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🍽️  Restaurant Platform running!`);
    console.log(`📍 Customer Website:  http://localhost:${PORT}`);
    console.log(`🔐 Admin Panel:       http://localhost:${PORT}/admin`);
    console.log(`👤 Admin Login:       admin / admin123\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
