// src/storage.js
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT, // e.g. https://ACCOUNTID.r2.cloudflarestorage.com
  forcePathStyle: false,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

async function signPutUrl({ bucket, key, contentType, expiresSec=900 }) {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream'
  });
  return await getSignedUrl(client, cmd, { expiresIn: expiresSec });
}

async function signGetUrl({ bucket, key, expiresSec=300 }) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return await getSignedUrl(client, cmd, { expiresIn: expiresSec });
}

module.exports = { signPutUrl, signGetUrl };