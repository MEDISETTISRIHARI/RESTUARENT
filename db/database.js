const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
const dbFile = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'restaurant.db');
const dbDir = path.dirname(dbFile);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db = null;
let SQL = null;

// ============ SCHEMA ============
const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  image TEXT,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS food_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  discount_price REAL,
  image TEXT,
  is_veg INTEGER DEFAULT 1,
  is_available INTEGER DEFAULT 1,
  is_featured INTEGER DEFAULT 0,
  is_popular INTEGER DEFAULT 0,
  ingredients TEXT,
  preparation_time INTEGER DEFAULT 15,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price_adjustment REAL DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  FOREIGN KEY (food_item_id) REFERENCES food_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price REAL DEFAULT 0,
  is_available INTEGER DEFAULT 1,
  FOREIGN KEY (food_item_id) REFERENCES food_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  password_hash TEXT,
  address TEXT,
  landmark TEXT,
  area TEXT,
  pincode TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  vehicle_type TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  customer_id INTEGER,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  customer_landmark TEXT,
  customer_area TEXT,
  customer_pincode TEXT,
  delivery_instructions TEXT,
  subtotal REAL NOT NULL,
  discount REAL DEFAULT 0,
  coupon_code TEXT,
  coupon_discount REAL DEFAULT 0,
  delivery_charge REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  grand_total REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT DEFAULT 'pending',
  order_status TEXT DEFAULT 'received',
  delivery_person_id INTEGER,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY (delivery_person_id) REFERENCES delivery_persons(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  food_item_id INTEGER,
  food_name TEXT NOT NULL,
  food_image TEXT,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  variant_name TEXT,
  addons_json TEXT,
  item_total REAL NOT NULL,
  promotion_discount REAL DEFAULT 0,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (food_item_id) REFERENCES food_items(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  transaction_id TEXT,
  payment_reference TEXT,
  payment_proof TEXT,
  rejection_reason TEXT,
  verified_by INTEGER,
  verified_at DATETIME,
  gateway_response TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES admin_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value REAL NOT NULL,
  min_order_value REAL DEFAULT 0,
  max_discount REAL,
  expiry_date DATETIME,
  usage_limit INTEGER,
  used_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  photo TEXT,
  is_approved INTEGER DEFAULT 0,
  is_featured INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  logo TEXT,
  tagline TEXT,
  description TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  opening_time TEXT DEFAULT '09:00',
  closing_time TEXT DEFAULT '22:00',
  is_open INTEGER DEFAULT 1,
  manual_status INTEGER DEFAULT 1,
  allow_ordering_when_closed INTEGER DEFAULT 0,
  delivery_charge REAL DEFAULT 40,
  min_order_value REAL DEFAULT 100,
  delivery_radius_km REAL DEFAULT 10,
  currency TEXT DEFAULT '₹',
  tax_rate REAL DEFAULT 5,
  payment_gateway TEXT DEFAULT 'razorpay',
  payment_gateway_key TEXT,
  payment_gateway_secret TEXT,
  upi_id TEXT,
  payment_upi_enabled INTEGER DEFAULT 1,
  payment_upi_name TEXT,
  payment_qr_enabled INTEGER DEFAULT 0,
  payment_qr_image TEXT,
  payment_bank_enabled INTEGER DEFAULT 0,
  payment_bank_holder TEXT,
  payment_bank_name TEXT,
  payment_bank_account TEXT,
  payment_bank_ifsc TEXT,
  payment_bank_branch TEXT,
  payment_direct_enabled INTEGER DEFAULT 0,
  payment_direct_number TEXT,
  payment_direct_name TEXT,
  facebook TEXT,
  instagram TEXT,
  twitter TEXT,
  youtube TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS homepage_content (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hero_title TEXT,
  hero_subtitle TEXT,
  hero_description TEXT,
  hero_image TEXT,
  hero_button_text TEXT,
  hero_button_link TEXT,
  about_title TEXT,
  about_description TEXT,
  about_image TEXT,
  offer_title TEXT,
  offer_description TEXT,
  offer_image TEXT,
  footer_about TEXT,
  footer_copyright TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  recipient_type TEXT DEFAULT 'admin',
  recipient_id INTEGER,
  order_id INTEGER,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value REAL NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all_products' CHECK (scope IN ('all_products', 'category', 'product')),
  products TEXT DEFAULT '[]',
  categories TEXT DEFAULT '[]',
  min_order_value REAL DEFAULT 0,
  max_discount REAL,
  start_date DATETIME,
  end_date DATETIME,
  is_active INTEGER DEFAULT 1,
  usage_limit INTEGER,
  used_count INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0,
  allow_stacking INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// ============ SEED DATA ============
function seedData() {
  const adminCount = db.exec('SELECT COUNT(*) as count FROM admin_users')[0]?.values[0][0] || 0;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO admin_users (username, email, password_hash) VALUES (?, ?, ?)', ['admin', 'admin@restaurant.com', hash]);
    console.log('✓ Default admin created: admin / admin123');
  }

  const settingsCount = db.exec('SELECT COUNT(*) as count FROM restaurant_settings')[0]?.values[0][0] || 0;
  if (settingsCount === 0) {
    db.run(`INSERT INTO restaurant_settings (id, name, tagline, description, address, phone, email, opening_time, closing_time, is_open, manual_status, delivery_charge, min_order_value, tax_rate, payment_gateway)
      VALUES (1, 'Spice Garden', 'Authentic Indian Flavors', 'Welcome to Spice Garden - serving delicious authentic Indian cuisine with love since 2010.', '123 Main Street, Indiranagar, Bengaluru 560038', '+91 98765 43210', 'hello@spicegarden.com', '09:00', '22:00', 1, 1, 40, 100, 5, 'razorpay')`);
    console.log('✓ Default restaurant settings created');
  }

  const homepageCount = db.exec('SELECT COUNT(*) as count FROM homepage_content')[0]?.values[0][0] || 0;
  if (homepageCount === 0) {
    db.run(`INSERT INTO homepage_content (id, hero_title, hero_subtitle, hero_description, hero_button_text, hero_button_link, about_title, about_description, offer_title, offer_description, footer_about, footer_copyright)
      VALUES (1, 'Delicious Food Delivered Hot & Fresh', 'Order from the best restaurant in town', 'Experience authentic flavors crafted with love. From sizzling starters to decadent desserts, we bring the finest dining experience to your doorstep.', 'Order Now', '/menu', 'Our Story', 'Spice Garden has been serving the community for over a decade. Our chefs use only the freshest ingredients and traditional recipes to create unforgettable meals.', 'Special Offers', 'Get 20% off on your first order! Use code WELCOME20 at checkout.', 'Spice Garden is your go-to destination for delicious, authentic Indian cuisine delivered hot and fresh to your doorstep.', '© 2026 Spice Garden. All rights reserved.')`);
    console.log('✓ Default homepage content created');
  }

  const catCount = db.exec('SELECT COUNT(*) as count FROM categories')[0]?.values[0][0] || 0;
  if (catCount === 0) {
    const cats = [
      ['Starters', 'starters', 'Crispy and delicious appetizers', 1],
      ['Main Course', 'main-course', 'Hearty and satisfying mains', 2],
      ['Biryani', 'biryani', 'Fragrant rice dishes', 3],
      ['Rice', 'rice', 'Steamed and fried rice', 4],
      ['Noodles', 'noodles', 'Stir-fried noodles', 5],
      ['Chinese', 'chinese', 'Indo-Chinese favorites', 6],
      ['Fast Food', 'fast-food', 'Quick bites and burgers', 7],
      ['Snacks', 'snacks', 'Light bites', 8],
      ['Desserts', 'desserts', 'Sweet endings', 9],
      ['Beverages', 'beverages', 'Refreshing drinks', 10]
    ];
    cats.forEach(c => db.run('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)', c));
    console.log('✓ Default categories created');
  }

  const foodCount = db.exec('SELECT COUNT(*) as count FROM food_items')[0]?.values[0][0] || 0;
  if (foodCount === 0) {
    const foods = [
      [1, 'Chicken 65', 'chicken-65', 'Crispy fried chicken tossed with curry leaves and spices', 220, 180, 0, 1, 1, 1, 'Chicken, yogurt, curry leaves, red chili, ginger-garlic paste', 20],
      [1, 'Paneer Tikka', 'paneer-tikka', 'Char-grilled cottage cheese cubes marinated in spices', 200, 0, 1, 1, 1, 0, 'Paneer, yogurt, spices, bell peppers, onions', 20],
      [2, 'Butter Chicken', 'butter-chicken', 'Tender chicken in rich creamy tomato butter sauce', 320, 280, 0, 1, 1, 1, 'Chicken, butter, cream, tomatoes, cashews, spices', 30],
      [2, 'Paneer Butter Masala', 'paneer-butter-masala', 'Paneer cubes in rich creamy tomato gravy', 280, 0, 1, 1, 1, 0, 'Paneer, butter, cream, tomatoes, spices', 25],
      [3, 'Chicken Biryani', 'chicken-biryani', 'Fragrant basmati rice layered with spiced chicken', 280, 240, 0, 1, 1, 1, 'Basmati rice, chicken, yogurt, saffron, mint, fried onions', 35],
      [3, 'Veg Biryani', 'veg-biryani', 'Basmati rice with mixed vegetables and aromatic spices', 220, 0, 1, 1, 1, 0, 'Basmati rice, mixed vegetables, yogurt, saffron, mint', 30],
      [4, 'Veg Fried Rice', 'veg-fried-rice', 'Wok-tossed rice with vegetables and soy sauce', 180, 0, 1, 1, 1, 0, 'Rice, mixed vegetables, soy sauce, spring onions', 15],
      [4, 'Chicken Fried Rice', 'chicken-fried-rice', 'Wok-tossed rice with chicken and vegetables', 220, 0, 0, 1, 1, 1, 'Rice, chicken, vegetables, soy sauce, eggs', 15],
      [5, 'Hakka Noodles', 'hakka-noodles', 'Stir-fried noodles with vegetables in Indo-Chinese style', 190, 0, 1, 1, 1, 0, 'Noodles, vegetables, soy sauce, garlic', 15],
      [5, 'Chicken Hakka Noodles', 'chicken-hakka-noodles', 'Stir-fried noodles with chicken and vegetables', 230, 0, 0, 1, 1, 1, 'Noodles, chicken, vegetables, soy sauce', 15],
      [6, 'Gobi Manchurian', 'gobi-manchurian', 'Crispy cauliflower florets in spicy Manchurian sauce', 200, 0, 1, 1, 1, 0, 'Cauliflower, cornflour, soy sauce, chili sauce, garlic', 20],
      [6, 'Chilli Chicken', 'chilli-chicken', 'Crispy chicken tossed in spicy chili sauce', 260, 0, 0, 1, 1, 1, 'Chicken, bell peppers, soy sauce, chili sauce', 20],
      [7, 'Veg Burger', 'veg-burger', 'Crispy veg patty with fresh veggies and sauces', 120, 99, 1, 1, 1, 0, 'Veg patty, lettuce, tomato, onion, cheese, sauces', 15],
      [7, 'Chicken Burger', 'chicken-burger', 'Juicy chicken patty with fresh veggies and sauces', 150, 0, 0, 1, 1, 1, 'Chicken patty, lettuce, tomato, onion, cheese, sauces', 15],
      [8, 'French Fries', 'french-fries', 'Crispy golden fries with peri-peri seasoning', 110, 0, 1, 1, 1, 0, 'Potatoes, salt, peri-peri seasoning', 10],
      [8, 'Samosa (2 pcs)', 'samosa-2-pcs', 'Crispy pastry filled with spiced potato', 60, 0, 1, 1, 1, 0, 'Potato, peas, spices, pastry', 10],
      [9, 'Gulab Jamun', 'gulab-jamun', 'Soft milk dumplings in sugar syrup', 90, 0, 1, 1, 1, 0, 'Milk solids, sugar, cardamom, rose water', 10],
      [9, 'Chocolate Brownie', 'chocolate-brownie', 'Rich fudgy brownie with chocolate sauce', 120, 0, 1, 1, 1, 0, 'Chocolate, butter, eggs, flour, sugar', 10],
      [10, 'Masala Chai', 'masala-chai', 'Spiced Indian tea with milk', 50, 0, 1, 1, 1, 0, 'Tea, milk, ginger, cardamom, cinnamon', 5],
      [10, 'Fresh Lime Soda', 'fresh-lime-soda', 'Refreshing lime soda with a hint of mint', 70, 0, 1, 1, 1, 0, 'Lime, soda, mint, sugar, salt', 5]
    ];
    foods.forEach(f => db.run(`INSERT INTO food_items (category_id, name, slug, description, price, discount_price, is_veg, is_available, is_featured, is_popular, ingredients, preparation_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f));
    console.log('✓ Default food items created');
  }

  const couponCount = db.exec('SELECT COUNT(*) as count FROM coupons')[0]?.values[0][0] || 0;
  if (couponCount === 0) {
    db.run(`INSERT INTO coupons (code, description, discount_type, discount_value, min_order_value, max_discount, expiry_date, usage_limit, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['WELCOME20', '20% off on your first order', 'percentage', 20, 200, 100, '2027-12-31', 1000, 1]);
    db.run(`INSERT INTO coupons (code, description, discount_type, discount_value, min_order_value, max_discount, expiry_date, usage_limit, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['FLAT50', 'Flat ₹50 off on orders above ₹500', 'fixed', 50, 500, null, '2027-12-31', 500, 1]);
    console.log('✓ Default coupons created');
  }

  const deliveryCount = db.exec('SELECT COUNT(*) as count FROM delivery_persons')[0]?.values[0][0] || 0;
  if (deliveryCount === 0) {
    db.run('INSERT INTO delivery_persons (name, phone, vehicle_type, is_active) VALUES (?, ?, ?, ?)', ['Rahul Kumar', '+91 90000 11111', 'Bike', 1]);
    db.run('INSERT INTO delivery_persons (name, phone, vehicle_type, is_active) VALUES (?, ?, ?, ?)', ['Amit Singh', '+91 90000 22222', 'Bike', 1]);
    console.log('✓ Default delivery persons created');
  }
}

// ============ WRAPPER ============
// sql.js is async; we wrap it with a simple query API.
// db.run(sql, params) -> executes and persists
// db.get(sql, params) -> returns first row as object
// db.all(sql, params) -> returns all rows as objects
// db.exec(sql) -> raw exec

function rowToObj(columns, row) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

function migrate() {
  const settingsCols = db.exec('PRAGMA table_info(restaurant_settings)')[0]?.values.map(v => v[1]) || [];
  if (!settingsCols.includes('payment_gateway')) {
    db.run("ALTER TABLE restaurant_settings ADD COLUMN payment_gateway TEXT DEFAULT 'razorpay'");
  }
  if (!settingsCols.includes('payment_gateway_key')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_gateway_key TEXT');
  }
  if (!settingsCols.includes('payment_gateway_secret')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_gateway_secret TEXT');
  }
  if (!settingsCols.includes('upi_id')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN upi_id TEXT');
  }
  if (!settingsCols.includes('payment_upi_enabled')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_upi_enabled INTEGER DEFAULT 1');
  }
  if (!settingsCols.includes('payment_upi_name')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_upi_name TEXT');
  }
  if (!settingsCols.includes('payment_qr_enabled')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_qr_enabled INTEGER DEFAULT 0');
  }
  if (!settingsCols.includes('payment_qr_image')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_qr_image TEXT');
  }
  if (!settingsCols.includes('payment_bank_enabled')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_bank_enabled INTEGER DEFAULT 0');
  }
  if (!settingsCols.includes('payment_bank_holder')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_bank_holder TEXT');
  }
  if (!settingsCols.includes('payment_bank_name')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_bank_name TEXT');
  }
  if (!settingsCols.includes('payment_bank_account')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_bank_account TEXT');
  }
  if (!settingsCols.includes('payment_bank_ifsc')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_bank_ifsc TEXT');
  }
  if (!settingsCols.includes('payment_bank_branch')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_bank_branch TEXT');
  }
  if (!settingsCols.includes('payment_direct_enabled')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_direct_enabled INTEGER DEFAULT 0');
  }
  if (!settingsCols.includes('payment_direct_number')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_direct_number TEXT');
  }
  if (!settingsCols.includes('payment_direct_name')) {
    db.run('ALTER TABLE restaurant_settings ADD COLUMN payment_direct_name TEXT');
  }

  const orderItemsCols = db.exec('PRAGMA table_info(order_items)')[0]?.values.map(v => v[1]) || [];
  if (!orderItemsCols.includes('promotion_discount')) {
    db.run('ALTER TABLE order_items ADD COLUMN promotion_discount REAL DEFAULT 0');
  }

  const paymentsCols = db.exec('PRAGMA table_info(payments)')[0]?.values.map(v => v[1]) || [];
  if (!paymentsCols.includes('payment_reference')) {
    db.run('ALTER TABLE payments ADD COLUMN payment_reference TEXT');
  }
  if (!paymentsCols.includes('payment_proof')) {
    db.run('ALTER TABLE payments ADD COLUMN payment_proof TEXT');
  }
  if (!paymentsCols.includes('rejection_reason')) {
    db.run('ALTER TABLE payments ADD COLUMN rejection_reason TEXT');
  }
  if (!paymentsCols.includes('verified_by')) {
    db.run('ALTER TABLE payments ADD COLUMN verified_by INTEGER');
  }
  if (!paymentsCols.includes('verified_at')) {
    db.run('ALTER TABLE payments ADD COLUMN verified_at DATETIME');
  }
  if (!paymentsCols.includes('updated_at')) {
    db.run('ALTER TABLE payments ADD COLUMN updated_at DATETIME');
  }

  const customerCols = db.exec('PRAGMA table_info(customers)')[0]?.values.map(v => v[1]) || [];
  if (!customerCols.includes('password_hash')) {
    db.run('ALTER TABLE customers ADD COLUMN password_hash TEXT');
  }
  if (!customerCols.includes('is_deleted')) {
    db.run('ALTER TABLE customers ADD COLUMN is_deleted INTEGER DEFAULT 0');
  }
  if (!customerCols.includes('deleted_at')) {
    db.run('ALTER TABLE customers ADD COLUMN deleted_at DATETIME');
  }
  if (!customerCols.includes('deleted_by')) {
    db.run('ALTER TABLE customers ADD COLUMN deleted_by INTEGER');
  }

  // Migrations for orders table
  const orderCols = db.exec('PRAGMA table_info(orders)')[0]?.values.map(v => v[1]) || [];
  if (!orderCols.includes('tracking_id')) {
    db.run('ALTER TABLE orders ADD COLUMN tracking_id TEXT');
  }
  if (!orderCols.includes('is_deleted')) {
    db.run('ALTER TABLE orders ADD COLUMN is_deleted INTEGER DEFAULT 0');
  }
  if (!orderCols.includes('deleted_at')) {
    db.run('ALTER TABLE orders ADD COLUMN deleted_at DATETIME');
  }
  if (!orderCols.includes('deleted_by')) {
    db.run('ALTER TABLE orders ADD COLUMN deleted_by INTEGER');
  }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_id ON orders(tracking_id) WHERE is_deleted != 1');

  // Backfill tracking_id for existing orders that don't have one
  db.run("UPDATE orders SET tracking_id = order_number WHERE tracking_id IS NULL");

  // Ensure is_deleted is 0 for all existing rows
  db.run('UPDATE orders SET is_deleted = 0 WHERE is_deleted IS NULL');


  const promoCols = db.exec('PRAGMA table_info(promotions)')[0]?.values.map(v => v[1]) || [];
  if (!promoCols.includes('id')) {
    db.run(`CREATE TABLE promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
      discount_value REAL NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all_products' CHECK (scope IN ('all_products', 'category', 'product')),
      products TEXT DEFAULT '[]',
      categories TEXT DEFAULT '[]',
      min_order_value REAL DEFAULT 0,
      max_discount REAL,
      start_date DATETIME,
      end_date DATETIME,
      is_active INTEGER DEFAULT 1,
      usage_limit INTEGER,
      used_count INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      allow_stacking INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
}

function init() {
  return initSqlJs().then((SQLModule) => {
    SQL = SQLModule;
    if (fs.existsSync(dbFile)) {
      const fileBuffer = fs.readFileSync(dbFile);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }
    db.run(SCHEMA);
    migrate();
    seedData();
    persist();
    console.log('✓ Database initialized');
    return db;
  });
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbFile, Buffer.from(data));
}

// Wrap db with helper methods
function sanitizeParams(params) {
  return (params || []).map(p => p === undefined ? null : p);
}

function wrapDb() {
  db.run = function (sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.run(sanitizeParams(params));
    const lastId = db.exec('SELECT last_insert_rowid() as id')[0]?.values[0][0] || 0;
    stmt.free();
    persist();
    return { changes: db.getRowsModified(), lastInsertRowid: lastId };
  };

  db.get = function (sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(sanitizeParams(params));
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  };

  db.all = function (sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(sanitizeParams(params));
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  };

  db.lastInsertRowid = function () {
    const r = db.exec('SELECT last_insert_rowid() as id');
    return r[0]?.values[0][0] || 0;
  };
}

module.exports = { init, getDb: () => db, persist, wrapDb };