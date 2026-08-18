const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { SCHEMA_POSTGRES } = require('../db/database');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'restaurant.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  console.error('Set it to your Supabase connection string:');
  console.error('postgres://postgres.xqzudmcjadzcogbtoihn:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');
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

const SQLITE_TYPE_MAP = {
  'INTEGER': 'INTEGER',
  'TEXT': 'TEXT',
  'REAL': 'REAL',
  'DATETIME': 'TIMESTAMP',
  'TIMESTAMP': 'TIMESTAMP',
  'BLOB': 'BYTEA'
};

const FK_REFS = {
  food_items: { category_id: 'categories' },
  variants: { food_item_id: 'food_items' },
  addons: { food_item_id: 'food_items' },
  orders: { customer_id: 'customers', delivery_person_id: 'delivery_persons' },
  order_items: { order_id: 'orders', food_item_id: 'food_items' },
  payments: { order_id: 'orders', verified_by: 'admin_users' },
  order_status_history: { order_id: 'orders' }
};

const validParentIds = {};
const orphanedRows = [];

async function reconcileSchema(pgClient, sqliteDb) {
  console.log('Reconciling PostgreSQL schema with SQLite...\n');

  for (const table of TABLES) {
    const sqliteInfo = sqliteDb.exec(`PRAGMA table_info(${table})`);
    if (!sqliteInfo.length) continue;

    const pgColumns = await pgClient.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'",
      [table]
    );
    const pgColSet = new Set(pgColumns.rows.map(r => r.column_name));

    let added = 0;
    for (const col of sqliteInfo[0].values) {
      const [, name, type, notnull, dflt_value, pk] = col;
      if (pgColSet.has(name)) continue;

      const upperType = type?.toUpperCase();
      const pgType = SQLITE_TYPE_MAP[upperType] || 'TEXT';

      let alterSql = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${pgType}`;

      if (dflt_value !== null && dflt_value !== undefined) {
        const strVal = String(dflt_value);
        let defaultClause;
        if (strVal === 'CURRENT_TIMESTAMP') {
          defaultClause = 'DEFAULT CURRENT_TIMESTAMP';
        } else if (strVal.startsWith("'") && strVal.endsWith("'")) {
          defaultClause = 'DEFAULT ' + strVal;
        } else {
          defaultClause = 'DEFAULT ' + strVal;
        }
        alterSql += ' ' + defaultClause;
      }

      await pgClient.query(alterSql);
      const defaultInfo = dflt_value !== null && dflt_value !== undefined ? ' DEFAULT ' + dflt_value : '';
      console.log(`  Added: ${table}.${name} ${pgType}${defaultInfo}`);
      added++;
    }

    if (added > 0) {
      console.log(`  ${added} column(s) added to ${table}\n`);
    }
  }
}

function checkOrphan(table, rowObj) {
  const fkMap = FK_REFS[table];
  if (!fkMap) return null;

  for (const [col, parentTable] of Object.entries(fkMap)) {
    const val = rowObj[col];
    if (val === null || val === undefined) continue;
    const parentIds = validParentIds[parentTable];
    if (!parentIds || !parentIds.has(val)) {
      return { column: col, parentTable, parentId: val };
    }
  }
  return null;
}

async function migrate() {
  console.log('=== PostgreSQL Migration Started ===\n');

  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: SQLite database not found at:', DB_PATH);
    process.exit(1);
  }

  console.log('Reading SQLite database...');
  const sqliteData = fs.readFileSync(DB_PATH);
  const SQL = await initSqlJs();
  const sqliteDb = new SQL.Database(sqliteData);

  console.log('Connecting to PostgreSQL...');
  const pgClient = await pool.connect();

  try {
    await pgClient.query('BEGIN');

    console.log('Creating PostgreSQL schema...');
    await pgClient.query(SCHEMA_POSTGRES);
    console.log('Schema created successfully.\n');

    await reconcileSchema(pgClient, sqliteDb);

    let hasExistingData = false;
    for (const table of TABLES) {
      const result = await pgClient.query(`SELECT COUNT(*) as count FROM ${table}`);
      if (result.rows[0].count > 0) {
        hasExistingData = true;
        console.log(`WARNING: Table "${table}" already has ${result.rows[0].count} rows in PostgreSQL.`);
      }
    }

    if (hasExistingData) {
      throw new Error('PostgreSQL database already contains data. Migration aborted to prevent data duplication. If you want to overwrite, truncate all tables first and re-run this script.');
    }

    for (const table of TABLES) {
      console.log(`Migrating ${table}...`);
      const rows = sqliteDb.exec(`SELECT * FROM ${table}`);
      if (!rows.length) {
        console.log(`  No data in ${table}`);
        continue;
      }

      const columns = rows[0].columns;
      const values = rows[0].values;

      if (values.length === 0) {
        console.log(`  No rows in ${table}`);
        continue;
      }

      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const columnNames = columns.join(', ');
      const sql = `INSERT INTO ${table} (${columnNames}) VALUES (${placeholders})`;

      let migrated = 0;
      let skipped = 0;
      const colIndexMap = {};
      columns.forEach((col, idx) => colIndexMap[col] = idx);

      for (const row of values) {
        const rowObj = {};
        columns.forEach((col, idx) => rowObj[col] = row[idx]);

        const orphan = checkOrphan(table, rowObj);
        if (orphan) {
          skipped++;
          orphanedRows.push({
            table,
            rowId: rowObj.id,
            missingParentTable: orphan.parentTable,
            missingParentId: orphan.parentId,
            reason: `${orphan.column}=${orphan.parentId} references missing ${orphan.parentTable}`
          });
          continue;
        }

        await pgClient.query(sql, row);
        migrated++;
      }

      console.log(`  Migrated ${migrated} rows` + (skipped > 0 ? `, skipped ${skipped} orphan(s)` : ''));

      const hasIdCol = columns.includes('id');
      if (hasIdCol) {
        const idResult = await pgClient.query(`SELECT id FROM ${table}`);
        validParentIds[table] = new Set(idResult.rows.map(r => r.id));
      }

      const hasIdResult = await pgClient.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id' AND table_schema = 'public'",
        [table]
      );

      if (hasIdResult.rows.length > 0) {
        const seqResult = await pgClient.query('SELECT pg_get_serial_sequence($1, $2) as seq', [table, 'id']);
        const seqName = seqResult.rows[0]?.seq;
        if (seqName) {
          await pgClient.query(`SELECT setval($1, COALESCE(MAX(id), 0) + 1, true) FROM ${table}`, [seqName]);
          console.log(`  Reset sequence for ${table}`);
        }
      }
    }

    console.log('\n=== Verification ===');
    let allMatch = true;
    for (const table of TABLES) {
      const pgResult = await pgClient.query(`SELECT COUNT(*) as count FROM ${table}`);
      const pgCount = parseInt(pgResult.rows[0].count);
      const sqliteResult = sqliteDb.exec(`SELECT COUNT(*) as count FROM ${table}`);
      const sqliteCount = sqliteResult[0]?.values[0][0] || 0;

      const skippedForTable = orphanedRows.filter(o => o.table === table).length;
      const expectedCount = sqliteCount - skippedForTable;
      const match = pgCount === expectedCount;
      if (!match) allMatch = false;
      const status = match ? 'OK' : 'MISMATCH';
      const note = skippedForTable > 0 ? ` (${skippedForTable} orphan(s) skipped)` : '';
      console.log(`${table}: PostgreSQL=${pgCount}, SQLite valid=${expectedCount} ${status}${note}`);
    }

    const admin = await pgClient.query("SELECT * FROM admin_users WHERE username = 'admin'");
    if (admin.rows.length > 0) {
      console.log('\nAdmin user: OK (username: ' + admin.rows[0].username + ')');
    } else {
      console.log('\nAdmin user: MISSING');
      allMatch = false;
    }

    const settings = await pgClient.query("SELECT * FROM restaurant_settings WHERE id = 1");
    if (settings.rows.length > 0) {
      console.log('Restaurant settings: OK (name: ' + settings.rows[0].name + ')');
    } else {
      console.log('Restaurant settings: MISSING');
      allMatch = false;
    }

    if (orphanedRows.length > 0) {
      console.log('\n=== Orphan Report ===');
      console.log('The following rows were skipped because their parent record does not exist in SQLite:\n');
      console.log('Table\t\tRow ID\tMissing Parent Table\tMissing Parent ID\tReason');
      console.log('-----\t\t-----\t---------------------\t----------------\t------');
      for (const o of orphanedRows) {
        console.log(`${o.table}\t\t${o.rowId}\t${o.missingParentTable}\t\t${o.missingParentId}\t${o.reason}`);
      }
      console.log(`\nTotal orphaned rows skipped: ${orphanedRows.length}`);
    }

    console.log('\n' + (allMatch ? 'All checks passed' : 'Some checks failed'));
    console.log('=== Migration Complete ===');

    await pgClient.query('COMMIT');
  } catch (err) {
    try {
      await pgClient.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback also failed:', rollbackErr);
    }
    console.error('\nMigration failed:', err);
    process.exit(1);
  } finally {
    pgClient.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
