// Mixtli Mini Backend • Limpio y listo para producción
// Node >= 18 (Fetch nativo). CommonJS para Render.
// Endpoints:
//   GET  /salud
//   POST /api/presign   -> { ok, url, token?, expiresAt?, headers? }
//   GET  /api/list      -> { ok, files: [{ key, name, size, contentType?, url? }] }
//
// Requisitos S3/R2 (usar R2 con compatibilidad S3):
//   S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
//   S3_BUCKET=<tu-bucket>
//   S3_REGION=auto
//   S3_FORCE_PATH_STYLE=true
//   S3_ACCESS_KEY_ID=<R2 access key>
//   S3_SECRET_ACCESS_KEY=<R2 secret key>
//
// Seguridad/CORS:
//   ALLOWED_ORIGINS=["https://tu-sitio.netlify.app","http://localhost:8888"]
//   ALLOW_NETLIFY_WILDCARD=true   (opcional, para *.netlify.app)
//   MIXTLI_TOKEN=<opcional; si se define, se exige en header x-mixtli-token>
//
// Comandos Render:
//   Build:  npm ci --omit=dev --no-audit --no-fund
//   Start:  node server.js

require('dotenv/config');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ------------ Config ------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const NODE_ENV = process.env.NODE_ENV || 'production';

const ALLOW = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); }
  catch { return []; }
})();

const REQUIRE_TOKEN = !!process.env.MIXTLI_TOKEN;

// S3/R2 client
const S3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});
const BUCKET = process.env.S3_BUCKET;

// Memory map para links (demo). En producción usar DB.
const linkMap = new Map(); // token -> { key, expiresAt }

// ------------ App ------------
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS estricto
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, false);
    if (ALLOW.includes(origin)) return cb(null, true);
    if (process.env.ALLOW_NETLIFY_WILDCARD === 'true' &&
        /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET','POST','PUT','OPTIONS'],
  allowedHeaders: ['Content-Type','x-mixtli-token'],
  credentials: false,
  optionsSuccessStatus: 204,
}));

// Token sencillo (opcional)
app.use((req, res, next) => {
  if (!REQUIRE_TOKEN) return next();
  const token = req.header('x-mixtli-token');
  if (token && token === process.env.MIXTLI_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'missing or invalid x-mixtli-token' });
});

// Salud
app.get('/salud', (req, res) => res.type('text').send('ok'));

// Utils
const sanitizeName = (name='') => name.replace(/[^\w.\-]+/g, '_').slice(0, 180);
const genId = (n=16) => crypto.randomBytes(n).toString('base64url');
const now = () => Math.floor(Date.now()/1000);

// Presign para PUT
app.post('/api/presign', async (req, res) => {
  try {
    const { name, size, type, mode } = req.body || {};
    if (!name || typeof size !== 'number') {
      return res.status(400).json({ ok: false, error: 'name/size required' });
    }
    if (!BUCKET || !process.env.S3_ENDPOINT) {
      return res.status(500).json({ ok: false, error: 'S3 config missing' });
    }

    const safe = sanitizeName(String(name));
    const prefix = mode === 'cloud' ? 'cloud' : 'link';
    const key = `${prefix}/${new Date().toISOString().slice(0,10)}/${genId(8)}-${safe}`;

    const contentType = type || 'application/octet-stream';
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(S3, command, { expiresIn: 60 * 15 }); // 15 min para subir

    const resp = { ok: true, url, headers: { 'Content-Type': contentType } };

    if (prefix === 'link') {
      const token = genId(18);
      const expiresAtSec = now() + 7*24*60*60; // 7 días
      linkMap.set(token, { key, expiresAt: expiresAtSec });
      resp.token = token;
      resp.expiresAt = new Date(expiresAtSec * 1000).toISOString();
    }

    return res.json(resp);
  } catch (err) {
    console.error('presign error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Listado simple (prefijo cloud/ y últimos 200 objetos)
app.get('/api/list', async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ ok: false, error: 'S3_BUCKET missing' });
    const Prefix = 'cloud/';
    let files = [];
    let ContinuationToken = undefined;
    do {
      const out = await S3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, MaxKeys: 200, ContinuationToken }));
      (out.Contents || []).forEach(obj => {
        if (!obj.Key || obj.Key.endsWith('/')) return;
        const name = obj.Key.split('/').slice(2).join('/') || obj.Key; // quitar cloud/yyyy-mm-dd/
        files.push({
          key: obj.Key,
          name,
          size: Number(obj.Size || 0),
        });
      });
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken && files.length < 200);

    // (Opcional) generar URL GET temporal para cada objeto
    const signed = await Promise.all(files.map(async f => {
      try {
        const head = await S3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: f.key }));
        const contentType = head.ContentType || null;
        const getUrl = await getSignedUrl(S3, new (require('@aws-sdk/client-s3').GetObjectCommand)({ Bucket: BUCKET, Key: f.key }), { expiresIn: 3600 });
        return { ...f, contentType, url: getUrl };
      } catch {
        return f;
      }
    }));

    return res.json({ ok: true, files: signed });
  } catch (err) {
    console.error('list error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Fallback
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

app.listen(PORT, () => {
  console.log(`Mixtli Mini backend on :${PORT}`);
});
