// src/storage.js
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

function makeS3({ endpoint, region = "auto", accessKeyId, secretAccessKey }) {
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: false,
    credentials: { accessKeyId, secretAccessKey },
  });
}

// primary (barato por defecto: B2)
function makePrimary() {
  const provider = (process.env.STORAGE_PROVIDER || "b2").toLowerCase();
  switch (provider) {
    case "b2":
      return {
        client: makeS3({
          endpoint: process.env.B2_ENDPOINT,
          accessKeyId: process.env.B2_ACCESS_KEY_ID,
          secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
        }),
        bucket: process.env.B2_BUCKET,
      };
    case "r2":
      return {
        client: makeS3({
          endpoint: process.env.R2_ENDPOINT,
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        }),
        bucket: process.env.R2_BUCKET,
      };
    case "s3":
      return {
        client: makeS3({
          endpoint: process.env.S3_ENDPOINT,
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }),
        bucket: process.env.S3_BUCKET,
      };
    default:
      throw new Error(`STORAGE_PROVIDER inválido: ${provider}`);
  }
}
const { client: primary, bucket: PRIMARY_BUCKET } = makePrimary();

// link store (egress/caché; por defecto R2, si no => primary)
function makeLinkStore() {
  const prov = (process.env.LINK_PROVIDER || "r2").toLowerCase();
  if (prov === "r2") {
    return {
      client: makeS3({
        endpoint: process.env.R2_ENDPOINT,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      }),
      bucket: process.env.R2_BUCKET,
    };
  }
  return { client: primary, bucket: PRIMARY_BUCKET };
}
const { client: linkStore, bucket: LINK_BUCKET } = makeLinkStore();

module.exports = {
  primary,
  PRIMARY_BUCKET,
  linkStore,
  LINK_BUCKET,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
};
