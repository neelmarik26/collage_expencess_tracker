const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const CLOUD_STORAGE = 'supabase-s3';
const LOCAL_STORAGE = 'local';
const uploadsDir = path.resolve(__dirname, '..', 'uploads');

const SUPABASE_S3_ENDPOINT = process.env.SUPABASE_S3_ENDPOINT;
const SUPABASE_REGION = process.env.SUPABASE_REGION || 'ap-south-1';
const SUPABASE_ACCESS_KEY_ID = process.env.SUPABASE_ACCESS_KEY_ID;
const SUPABASE_SECRET_ACCESS_KEY = process.env.SUPABASE_SECRET_ACCESS_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'photos';
const SUPABASE_URL_EXPIRATION_SECONDS = Number(process.env.SUPABASE_URL_EXPIRATION_SECONDS || 3600);

let s3Client;

const mimeExtensions = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif'
};

function hasAnySupabaseConfig() {
  return Boolean(SUPABASE_S3_ENDPOINT || SUPABASE_ACCESS_KEY_ID || SUPABASE_SECRET_ACCESS_KEY);
}

function hasFullSupabaseConfig() {
  return Boolean(SUPABASE_S3_ENDPOINT && SUPABASE_ACCESS_KEY_ID && SUPABASE_SECRET_ACCESS_KEY);
}

function assertSupabaseConfig() {
  if (!hasFullSupabaseConfig()) {
    throw new Error(
      'Missing Supabase S3 configuration. Set SUPABASE_S3_ENDPOINT, SUPABASE_ACCESS_KEY_ID, and SUPABASE_SECRET_ACCESS_KEY.'
    );
  }
}

function getS3Client() {
  assertSupabaseConfig();

  if (!s3Client) {
    s3Client = new S3Client({
      region: SUPABASE_REGION,
      endpoint: SUPABASE_S3_ENDPOINT,
      credentials: {
        accessKeyId: SUPABASE_ACCESS_KEY_ID,
        secretAccessKey: SUPABASE_SECRET_ACCESS_KEY
      },
      forcePathStyle: true
    });
  }

  return s3Client;
}

function makeSafeSegment(value, fallback) {
  const safeValue = String(value || '')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return safeValue || fallback;
}

function getFileExtension(file) {
  const originalExtension = path.extname(file.originalname || '').toLowerCase();
  if (/^\.[a-z0-9]+$/.test(originalExtension)) {
    return originalExtension;
  }

  return mimeExtensions[file.mimetype] || '';
}

function makeSafeObjectKey(file, folder) {
  const safeFolder = String(folder || 'uploads')
    .split(/[\\/]+/)
    .map((segment) => makeSafeSegment(segment, 'uploads'))
    .join('/');
  const extension = getFileExtension(file);
  const baseName = makeSafeSegment(path.basename(file.originalname || 'image', extension), 'image');
  const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${baseName}${extension}`;

  return `${safeFolder}/${uniqueName}`;
}

async function createSignedUrl(objectKey) {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: SUPABASE_BUCKET,
      Key: objectKey
    }),
    {
      expiresIn: Number.isFinite(SUPABASE_URL_EXPIRATION_SECONDS) && SUPABASE_URL_EXPIRATION_SECONDS > 0
        ? SUPABASE_URL_EXPIRATION_SECONDS
        : 3600
    }
  );
}

async function uploadToCloud(file, objectKey) {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: SUPABASE_BUCKET,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/octet-stream'
    })
  );

  return {
    url: await createSignedUrl(objectKey),
    key: objectKey,
    storage: CLOUD_STORAGE
  };
}

async function uploadToLocal(file, objectKey) {
  const filePath = path.resolve(uploadsDir, objectKey);
  if (!filePath.startsWith(`${uploadsDir}${path.sep}`)) {
    throw new Error('Invalid upload path.');
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, file.buffer);

  return {
    url: `/uploads/${objectKey}`,
    key: objectKey,
    storage: LOCAL_STORAGE
  };
}

async function uploadStoredImage(file, folder) {
  if (!file || !file.buffer) {
    throw new Error('Image file is required.');
  }

  const objectKey = makeSafeObjectKey(file, folder);

  if (hasAnySupabaseConfig()) {
    return uploadToCloud(file, objectKey);
  }

  return uploadToLocal(file, objectKey);
}

async function getStoredImageUrl(image) {
  if (!image) return '';

  if (image.storage === CLOUD_STORAGE && image.key) {
    if (!hasFullSupabaseConfig()) {
      return image.url || '';
    }

    return createSignedUrl(image.key);
  }

  return image.url || '';
}

async function hydrateStoredImageUrls(records, fieldName = 'billImage') {
  await Promise.all(
    records
      .filter(Boolean)
      .map(async (record) => {
        const imageUrl = await getStoredImageUrl({
          url: record[fieldName],
          key: record[`${fieldName}Key`],
          storage: record[`${fieldName}Storage`]
        });

        if (imageUrl) {
          record[fieldName] = imageUrl;
        }
      })
  );

  return records;
}

function getLocalRelativePath(image) {
  const localValue = image.key || (image.url && image.url.startsWith('/uploads/') ? image.url.slice('/uploads/'.length) : '');
  if (!localValue) return '';

  const withoutQuery = localValue.split('?')[0].replace(/^\/+/, '');
  try {
    return decodeURIComponent(withoutQuery);
  } catch (err) {
    return '';
  }
}

async function deleteLocalImage(image) {
  const relativePath = getLocalRelativePath(image);
  if (!relativePath) return;

  const filePath = path.resolve(uploadsDir, relativePath);
  if (!filePath.startsWith(`${uploadsDir}${path.sep}`)) return;

  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function deleteStoredImage(image) {
  if (!image) return;

  if (image.storage === CLOUD_STORAGE) {
    if (!image.key) return;

    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: SUPABASE_BUCKET,
        Key: image.key
      })
    );
    return;
  }

  await deleteLocalImage(image);
}

async function deleteStoredImages(images) {
  await Promise.all(images.filter(Boolean).map(deleteStoredImage));
}

function imageFromRecord(record, fieldName = 'billImage') {
  if (!record) return null;

  return {
    url: record[fieldName],
    key: record[`${fieldName}Key`],
    storage: record[`${fieldName}Storage`]
  };
}

module.exports = {
  CLOUD_STORAGE,
  LOCAL_STORAGE,
  deleteStoredImage,
  deleteStoredImages,
  hydrateStoredImageUrls,
  imageFromRecord,
  uploadStoredImage
};
