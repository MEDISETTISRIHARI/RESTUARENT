const fs = require('fs');
const path = require('path');
const { init, getDb, wrapDb, isPostgres } = require('../db/database');
const { uploadToStorage, isStorageConfigured } = require('../utils/storage');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

function collectUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return /\.(png|jpg|jpeg|gif|webp)$/i.test(ext);
  });
}

function buildOldUrl(filename) {
  return '/public/uploads/' + filename;
}

async function migrate() {
  console.log('=== Image Migration Started ===\n');

  if (!isStorageConfigured()) {
    console.error('ERROR: Persistent storage is not configured.');
    console.error('Set STORAGE_BACKEND=s3 (or r2) and provide S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, and S3_PUBLIC_URL environment variables.');
    process.exit(1);
  }

  await init();
  wrapDb();
  const db = getDb();

  const files = collectUploads();
  if (files.length === 0) {
    console.log('No files found in public/uploads/. Nothing to migrate.');
    return;
  }

  console.log('Found ' + files.length + ' file(s) in public/uploads/\n');

  const report = {
    uploaded: [],
    skipped: [],
    updated: [],
    failed: []
  };

  for (const filename of files) {
    const filepath = path.join(UPLOAD_DIR, filename);
    const oldUrl = buildOldUrl(filename);

    const paymentsCount = await db.get("SELECT COUNT(*) as cnt FROM payments WHERE payment_proof = ?", [oldUrl]);
    const settingsCount = await db.get("SELECT COUNT(*) as cnt FROM restaurant_settings WHERE payment_qr_image = ?", [oldUrl]);
    const refCount = (paymentsCount ? paymentsCount.cnt : 0) + (settingsCount ? settingsCount.cnt : 0);

    if (refCount === 0) {
      report.skipped.push({ filename, oldUrl, reason: 'No database references found' });
      console.log('Skipped: ' + filename + ' (no DB references)');
      continue;
    }

    let newUrl = null;

    try {
      const buffer = fs.readFileSync(filepath);
      const ext = path.extname(filename);
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const key = 'uploads/' + unique + ext;

      const result = await uploadToStorage(buffer, filename, 'image/' + ext.replace('.', ''));
      newUrl = result;
      report.uploaded.push({ filename, oldUrl, newUrl });
      console.log('Uploaded: ' + filename + ' -> ' + newUrl);
    } catch (err) {
      console.error('Failed to upload: ' + filename + ' - ' + err.message);
      report.failed.push({ filename, oldUrl, error: err.message });
      continue;
    }

    if (!newUrl) {
      console.error('No URL returned for: ' + filename);
      report.failed.push({ filename, oldUrl, error: 'No URL returned' });
      continue;
    }

    const payments = await db.all("SELECT id, payment_proof FROM payments WHERE payment_proof = ?", [oldUrl]);
    if (payments.length > 0) {
      await db.run("UPDATE payments SET payment_proof = ? WHERE payment_proof = ?", [newUrl, oldUrl]);
      report.updated.push({ table: 'payments', column: 'payment_proof', oldUrl, newUrl, count: payments.length });
      console.log('  Updated ' + payments.length + ' payment record(s)');
    }

    const settings = await db.get("SELECT id, payment_qr_image FROM restaurant_settings WHERE payment_qr_image = ?", [oldUrl]);
    if (settings) {
      await db.run("UPDATE restaurant_settings SET payment_qr_image = ? WHERE payment_qr_image = ?", [newUrl, oldUrl]);
      report.updated.push({ table: 'restaurant_settings', column: 'payment_qr_image', oldUrl, newUrl, count: 1 });
      console.log('  Updated restaurant_settings QR image');
    }
  }

  console.log('\n=== Migration Report ===');
  console.log('Uploaded: ' + report.uploaded.length);
  console.log('Updated records: ' + report.updated.length);
  console.log('Skipped: ' + report.skipped.length);
  console.log('Failed: ' + report.failed.length);

  if (report.failed.length > 0) {
    console.log('\nFailed files:');
    report.failed.forEach(f => console.log('  ' + f.filename + ': ' + f.error));
  }

  console.log('\n=== Migration Complete ===');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
