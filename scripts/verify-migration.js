const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'restaurant.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const TABLES = [
  'admin_users',
  'categories',
  'restaurant_settings',
  'homepage_content',
  'food_items',
  'variants',
  'addons',
  'coupons',
  'promotions',
  'delivery_persons',
  'customers',
  'orders',
  'order_items',
  'payments',
  'reviews',
  'notifications',
  'order_status_history'
];

async function verify() {
  console.log('=== Migration Verification ===\n');

  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: SQLite database not found at:', DB_PATH);
    process.exit(1);
  }

  const sqliteData = fs.readFileSync(DB_PATH);
  const SQL = await initSqlJs();
  const sqliteDb = new SQL.Database(sqliteData);

  const pgClient = await pool.connect();

  try {
    let allMatch = true;

    for (const table of TABLES) {
      const pgResult = await pgClient.query(`SELECT COUNT(*) as count FROM ${table}`);
      const pgCount = parseInt(pgResult.rows[0].count);
      const sqliteResult = sqliteDb.exec(`SELECT COUNT(*) as count FROM ${table}`);
      const sqliteCount = sqliteResult[0]?.values[0][0] || 0;
      const match = pgCount === sqliteCount;
      if (!match) allMatch = false;
      console.log(`${table}: PostgreSQL=${pgCount}, SQLite=${sqliteCount} ${match ? 'OK' : 'MISMATCH'}`);
    }

    const admin = await pgClient.query("SELECT id, username, email FROM admin_users WHERE username = 'admin'");
    if (admin.rows.length > 0) {
      console.log('\nAdmin user: OK');
      console.log('  Username: ' + admin.rows[0].username);
      console.log('  Email: ' + admin.rows[0].email);
    } else {
      console.log('\nAdmin user: MISSING');
      allMatch = false;
    }

    const settings = await pgClient.query("SELECT id, name, address, phone FROM restaurant_settings WHERE id = 1");
    if (settings.rows.length > 0) {
      console.log('\nRestaurant settings: OK');
      console.log('  Name: ' + settings.rows[0].name);
    } else {
      console.log('\nRestaurant settings: MISSING');
      allMatch = false;
    }

    const categories = await pgClient.query('SELECT COUNT(*) as count FROM categories');
    console.log('\nCategories: ' + categories.rows[0].count);

    const foodItems = await pgClient.query('SELECT COUNT(*) as count FROM food_items');
    console.log('Food items: ' + foodItems.rows[0].count);

    const orders = await pgClient.query('SELECT COUNT(*) as count FROM orders');
    console.log('Orders: ' + orders.rows[0].count);

    console.log('\n' + (allMatch ? 'All checks passed' : 'Some checks failed'));
    process.exit(allMatch ? 0 : 1);
  } finally {
    pgClient.release();
    await pool.end();
  }
}

verify().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
