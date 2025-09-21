// Mixtli Mini Backend v1.1 — Express + S3/R2 presign + share links
require('dotenv/config');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const NODE_ENV = process.env.NODE_ENV || 'production';

const ALLOW = (() => { try { return JSON.parse(process.env.ALLOWED_ORIGINS || '[]'); } catch { return []; } })();
const REQUIRE_TOKEN = !!process.env.MIXTLI_TOKEN;

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

const app = express();
app.use(express.json({ limit: '10mb' }));

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

// Simple token guard
app.use((req, res, next) => {
  if (!REQUIRE_TOKEN) return next();
  const token = req.header('x-mixtli-token');
  if (token && token === process.env.MIXTLI_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'missing or invalid x-mixtli-token' });
});

// ---- In-memory share map (demo) ----
const linkMap = new Map(); // token -> { key, expiresAt }

const sanitizeName = (name='') => name.replace(/[^\w.\-]+/g, '_').slice(0, 180);
const genId = (n=16) => crypto.randomBytes(n).toString('base64url');
const now = () => Math.floor(Date.now()/1000);

app.get('/salud', (req, res) => res.type('text').send('ok'));

// ---- Presign for PUT ----
app.post('/api/presign', async (req, res) => {
  try {
    const { name, size, type, mode } = req.body || {};
    if (!name || typeof size !== 'number') return res.status(400).json({ ok: false, error: 'name/size required' });
    if (!BUCKET || !process.env.S3_ENDPOINT) return res.status(500).json({ ok: false, error: 'S3 config missing' });

    const safe = sanitizeName(String(name));
    const prefix = mode === 'cloud' ? 'cloud' : 'link';
    const key = `${prefix}/${new Date().toISOString().slice(0,10)}/${genId(8)}-${safe}`;

    const contentType = type || 'application/octet-stream';
    const url = await getSignedUrl(S3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: 60 * 15 });

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

// ---- List cloud files ----
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
        files.push({ key: obj.Key, name, size: Number(obj.Size || 0) });
      });
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken && files.length < 200);

    // Optional signed GET for each
    const signed = await Promise.all(files.map(async f => {
      try {
        const head = await S3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: f.key }));
        const contentType = head.ContentType || null;
        const getUrl = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: f.key }), { expiresIn: 3600 });
        return { ...f, contentType, url: getUrl };
      } catch { return f; }
    }));

    return res.json({ ok: true, files: signed });
  } catch (err) {
    console.error('list error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ---- Resolve share token: JSON ----
app.get('/api/readlink', async (req, res) => {
  try {
    const token = (req.query.token || req.query.t || '').toString();
    const rec = linkMap.get(token);
    if (!rec) return res.status(404).json({ ok: false, error: 'token not found' });
    if (rec.expiresAt <= now()) { linkMap.delete(token); return res.status(410).json({ ok: false, error: 'token expired' }); }
    const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: rec.key }), { expiresIn: 300 });
    return res.json({ ok: true, url, key: rec.key, expiresIn: 300 });
  } catch (err) {
    console.error('readlink error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ---- Resolve share token: redirect ----
app.get('/s/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const rec = linkMap.get(token);
    if (!rec) return res.status(404).type('text').send('Link no encontrado');
    if (rec.expiresAt <= now()) { linkMap.delete(token); return res.status(410).type('text').send('Link expirado'); }
    const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: rec.key }), { expiresIn: 300 });
    return res.redirect(302, url);
  } catch (err) {
    console.error('s/:token error:', err);
    return res.status(500).type('text').send('Error al generar link');
  }
});

// Fallback
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

app.listen(PORT, () => console.log(`Mixtli Mini backend v1.1 on :${PORT}`));
