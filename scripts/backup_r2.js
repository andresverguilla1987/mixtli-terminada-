// scripts/backup_r2.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'mixtli.sqlite');
const BUCKET = process.env.R2_BACKUP_BUCKET || process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT;
const REGION = process.env.S3_REGION || 'auto';
const FORCE_PATH = String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

if (!fs.existsSync(DB_FILE)) {
  console.error(`[x] No existe ${DB_FILE}. Define DATA_DIR o crea la DB primero.`);
  process.exit(1);
}
if (!BUCKET || !ENDPOINT || !ACCESS_KEY || !SECRET_KEY) {
  console.error(`[x] Faltan variables de entorno: R2_BACKUP_BUCKET/S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY`);
  process.exit(1);
}

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: FORCE_PATH,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

function yyyymmddhhmmss(d=new Date()){
  const p = (n)=> String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function main(){
  const now = new Date();
  const name = `backup-${yyyymmddhhmmss(now)}.sqlite.gz`;
  const key = `backups/${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${name}`;

  console.log(`[i] Leyendo DB: ${DB_FILE}`);
  const raw = fs.readFileSync(DB_FILE);
  console.log(`[i] Comprimendo… (${(raw.length/1024).toFixed(1)} KB)`);
  const gz = zlib.gzipSync(raw, { level: 9 });

  console.log(`[i] Subiendo a r2://${BUCKET}/${key}`);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: gz,
    ContentType: 'application/gzip',
    Metadata: { source: 'mixtli-backup', db: 'sqlite' },
  }));
  console.log(`[✓] Backup listo: s3://${BUCKET}/${key}  (${(gz.length/1024).toFixed(1)} KB gz)`);
}

main().catch(err => { console.error(err); process.exit(1); });
