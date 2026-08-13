// Read-only DB inspection utility
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'data', 'restaurant.db');

initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync(dbFile));
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.map(v => v[0]);
  console.log('TABLES:\n  ' + tables.join('\n  '));

  if (tables.includes('promotions')) {
    const cols = db.exec('PRAGMA table_info(promotions)')[0].values.map(v => `${v[1]} ${v[2]}`);
    console.log('\npromotions columns:\n  ' + cols.join('\n  '));
    const rows = db.exec('SELECT * FROM promotions');
    console.log('\npromotions rows:', rows.length ? JSON.stringify(rows[0].values, null, 2) : '(none)');
  } else {
    console.log('\n!! promotions TABLE DOES NOT EXIST');
  }

  const fi = db.exec('SELECT id, name, price, discount_price, category_id FROM food_items LIMIT 8');
  console.log('\nfood_items sample:');
  if (fi.length) fi[0].values.forEach(v => console.log('  ' + v.join(' | ')));

  const cats = db.exec('SELECT id, name, slug FROM categories');
  console.log('\ncategories:');
  if (cats.length) cats[0].values.forEach(v => console.log('  ' + v.join(' | ')));
}).catch(e => { console.error('ERR', e); process.exit(1); });
