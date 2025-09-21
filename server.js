// Mixtli Backend v2.1 — SQLite3 only (sin paquete 'sqlite')
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Database } = require('sqlite3');
const { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT = Number(process.env.PORT || 10000);
const ALLOW = (() => { try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; } })();
const REQUIRE_TOKEN = !!process.env.MIXTLI_TOKEN;
const CLEANUP_INTERVAL_MIN = Number(process.env.CLEANUP_INTERVAL_MIN || 15);

// S3/R2
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

// --------- DB (sqlite3 callbacks) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'mixtli.sqlite');

const db = new Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS links (
    token TEXT PRIMARY KEY,
    s3key TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_links_expires ON links (expiresAt)`);
});
const nowSec = () => Math.floor(Date.now()/1000);
const sanitizeName = (name='') => name.replace(/[^\w.\-]+/g, '_').slice(0, 180);
const genId = (n=16) => crypto.randomBytes(n).toString('base64url');

function dbRun(sql, params=[]) { return new Promise((resolve,reject)=> db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); })); }
function dbGet(sql, params=[]) { return new Promise((resolve,reject)=> db.get(sql, params, (err,row)=> err?reject(err):resolve(row||null))); }

// --------- App ----------
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

// Token opcional
app.use((req, res, next) => {
  if (!REQUIRE_TOKEN) return next();
  const token = req.header('x-mixtli-token');
  if (token && token === process.env.MIXTLI_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'missing or invalid x-mixtli-token' });
});

// Rate limit
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/api/presign','/api/list','/api/readlink'], limiter);

// Salud
app.get('/salud', (req, res) => res.type('text').send('ok'));

// Presign
app.post('/api/presign', async (req, res) => {
  try {
    const { name, size, type, mode } = req.body || {};
    if (!name || typeof size !== 'number') return res.status(400).json({ ok: false, error: 'name/size required' });
    if (!BUCKET || !process.env.S3_ENDPOINT) return res.status(500).json({ ok: false, error: 'S3 config missing' });

    const MAX_BYTES = Number(process.env.MAX_BYTES || (2*1024*1024*1024));
    if (size > MAX_BYTES) return res.status(413).json({ ok: false, error: `size exceeds limit ${MAX_BYTES}` });

    const safe = sanitizeName(String(name));
    const prefix = mode === 'cloud' ? 'cloud' : 'link';
    const key = `${prefix}/${new Date().toISOString().slice(0,10)}/${genId(8)}-${safe}`;

    const contentType = type || 'application/octet-stream';
    const url = await getSignedUrl(S3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: 60 * 15 });

    const resp = { ok: true, url, headers: { 'Content-Type': contentType } };
    if (prefix === 'link') {
      const token = genId(18);
      const ttlDays = Number(process.env.LINK_TTL_DAYS || 7);
      const expiresAt = nowSec() + ttlDays*24*60*60;
      await dbRun(`INSERT OR REPLACE INTO links(token,s3key,expiresAt) VALUES(?,?,?)`, [token, key, expiresAt]);
      resp.token = token;
      resp.expiresAt = new Date(expiresAt * 1000).toISOString();
    }
    res.json(resp);
  } catch (err) {
    console.error('presign error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// List
app.get('/api/list', async (req, res) => {
  try {
    const Prefix = 'cloud/';
    let files = [];
    let ContinuationToken = undefined;
    do {
      const out = await S3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, MaxKeys: 200, ContinuationToken }));
      (out.Contents || []).forEach(obj => {
        if (!obj.Key || obj.Key.endsWith('/')) return;
        const name = obj.Key.split('/').slice(2).join('/') || obj.Key;
        files.push({ key: obj.Key, name, size: Number(obj.Size || 0) });
      });
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken && files.length < 200);

    const signed = await Promise.all(files.map(async f => {
      try {
        const head = await S3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: f.key }));
        const getUrl = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: f.key }), { expiresIn: 3600 });
        return { ...f, contentType: head.ContentType || null, url: getUrl };
      } catch { return f; }
    }));

    res.json({ ok: true, files: signed });
  } catch (err) {
    console.error('list error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Readlink JSON
app.get('/api/readlink', async (req, res) => {
  try {
    const token = (req.query.token || req.query.t || '').toString();
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    const row = await dbGet(`SELECT token,s3key,expiresAt FROM links WHERE token=?`, [token]);
    if (!row) return res.status(404).json({ ok: false, error: 'token not found' });
    if (row.expiresAt <= nowSec()) { await dbRun(`DELETE FROM links WHERE token=?`, [token]); return res.status(410).json({ ok: false, error: 'token expired' }); }
    const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: row.s3key }), { expiresIn: 300 });
    res.json({ ok: true, url, key: row.s3key, expiresIn: 300 });
  } catch (err) {
    console.error('readlink error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Share redirect
app.get('/s/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const row = await dbGet(`SELECT token,s3key,expiresAt FROM links WHERE token=?`, [token]);
    if (!row) return res.status(404).type('text').send('Link no encontrado');
    if (row.expiresAt <= nowSec()) { await dbRun(`DELETE FROM links WHERE token=?`, [token]); return res.status(410).type('text').send('Link expirado'); }
    const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: row.s3key }), { expiresIn: 300 });
    res.redirect(302, url);
  } catch (err) {
    console.error('s/:token error:', err);
    res.status(500).type('text').send('Error al generar link');
  }
});

// Limpieza automática
setInterval(async () => {
  try {
    const res = await dbRun(`DELETE FROM links WHERE expiresAt <= ?`, [nowSec()]);
    if (res && res.changes) console.log(`[cleanup] removed ${res.changes} expired links`);
  } catch (e) {
    console.error('[cleanup] error:', e);
  }
}, CLEANUP_INTERVAL_MIN * 60 * 1000);

app.use((req,res)=> res.status(404).json({ ok:false, error:'Not Found' }));

app.listen(PORT, () => console.log(`Mixtli Backend v2.1 on :${PORT} (db=${DB_PATH})`));
