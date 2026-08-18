const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const storageBackend = process.env.STORAGE_BACKEND;
let s3Client = null;
let s3Bucket = null;
let publicUrlBase = null;
let storageReady = false;

function validateRequiredEnv(vars) {
  const missing = vars.filter(name => !process.env[name] || !process.env[name].trim());
  if (missing.length > 0) {
    throw new Error(`S3 storage is enabled but missing required environment variables: ${missing.join(', ')}`);
  }
}

if (storageBackend === 's3' || storageBackend === 'r2') {
  validateRequiredEnv([
    'S3_REGION',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET',
    'S3_PUBLIC_URL'
  ]);
  s3Client = new S3Client({
  forcePathStyle: true,
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
  s3Bucket = process.env.S3_BUCKET;
  publicUrlBase = process.env.S3_PUBLIC_URL;
  storageReady = true;
}

async function uploadToStorage(fileBuffer, fileName, contentType) {
  if (!storageReady) {
    throw new Error('Persistent image storage is not configured. Set STORAGE_BACKEND=s3 (or r2) and provide S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, and S3_PUBLIC_URL environment variables.');
  }

  const ext = path.extname(fileName);
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const key = 'uploads/' + unique + ext;

  await s3Client.send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  if (publicUrlBase) {
    return publicUrlBase.replace(/\/$/, '') + '/' + key;
  }

  const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/$/, '');
  return endpoint + '/' + s3Bucket + '/' + key;
}

function isStorageConfigured() {
  return storageReady;
}

module.exports = { uploadToStorage, s3Client, isStorageConfigured };
