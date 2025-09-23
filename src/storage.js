const { S3Client } = require("@aws-sdk/client-s3");

function makeS3({ endpoint, region="auto", accessKeyId, secretAccessKey }) {
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: false,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function makePrimary() {
  const provider = process.env.STORAGE_PROVIDER || "b2";
  if (provider === "b2") {
    return {
      client: makeS3({
        endpoint: process.env.B2_ENDPOINT,
        accessKeyId: process.env.B2_ACCESS_KEY_ID,
        secretAccessKey: process.env.B2_SECRET_ACCESS_KEY
      }),
      bucket: process.env.B2_BUCKET
    };
  }
  if (provider === "r2") {
    return {
      client: makeS3({
        endpoint: process.env.R2_ENDPOINT,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }),
      bucket: process.env.R2_BUCKET
    };
  }
  // fallback genérico (S3 compatible)
  return {
    client: makeS3({
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }),
    bucket: process.env.S3_BUCKET
  };
}

function makeLinkStore(primary) {
  const linkProv = process.env.LINK_PROVIDER || "r2";
  if (linkProv === "r2") {
    return {
      client: makeS3({
        endpoint: process.env.R2_ENDPOINT,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }),
      bucket: process.env.R2_BUCKET
    };
  }
  // fallback: usa el primario
  return { client: primary.client, bucket: primary.bucket };
}

module.exports = { makePrimary, makeLinkStore };
