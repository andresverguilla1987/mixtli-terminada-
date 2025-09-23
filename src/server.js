// src/server.js
// Mixtli Transfer - minimal backend (Render + R2)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { db, initDB, createTransfer, addFile, finalizeFile, ensureCode, getTransferByCode } = require('./db');
const { signPutUrl, signGetUrl } = require('./storage');

const app = express();

// trust proxy for rate-limit & IPs behind Render
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// CORS
const ALLOWED_ORIGINS = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || "[]"); }
  catch { return []; }
})();

function isAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (process.env.ALLOW_NETLIFY_WILDCARD === "true" &&
      /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-mixtli-token");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(morgan('tiny'));

// rate limit
const RL_WINDOW_MIN = parseInt(process.env.RL_WINDOW_MIN || "10", 10);
const RL_MAX_REQ = parseInt(process.env.RL_MAX_REQ || "600", 10);
app.use(rateLimit({
  windowMs: RL_WINDOW_MIN * 60 * 1000,
  max: RL_MAX_REQ
}));

// Init DB
initDB();

// Health/version
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/version', (_, res) => res.json({ version: 'mixtli-transfer-1.0.0' }));

// Utils
function required(v, name) {
  if (v === undefined || v === null || v === '') {
    const err = new Error(`Missing ${name}`);
    err.status = 400;
    throw err;
  }
}
function tokenFrom(req) {
  const t = req.headers['x-mixtli-token'];
  if (!t) {
    const err = new Error('x-mixtli-token required');
    err.status = 401;
    throw err;
  }
  return String(t);
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function nowSec(){ return Math.floor(Date.now()/1000); }
function randomId(len=12){ const a='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let s=''; for(let i=0;i<len;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }

// Limits
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "2048", 10);
const MAX_TRANSFER_SIZE_MB = parseInt(process.env.MAX_TRANSFER_SIZE_MB || "3072", 10);
const TRANSFER_TTL_DAYS = parseInt(process.env.TRANSFER_TTL_DAYS || "7", 10);

// 1) PRESIGN a PUT to R2
app.post('/api/presign', async (req, res) => {
  try {
    const token = tokenFrom(req);
    const { filename, size, contentType } = req.body || {};
    required(filename, 'filename');
    required(size, 'size');

    const sizeMB = Math.ceil(Number(size)/ (1024*1024));
    if (sizeMB > MAX_FILE_SIZE_MB) {
      return res.status(400).json({ ok: false, error: 'File too large' });
    }

    const transfer = createTransfer({ userToken: token, ttlDays: TRANSFER_TTL_DAYS });
    const key = `link/${encodeURIComponent(token)}/${Date.now()}_${randomId(6)}_${filename.replace(/\s+/g,'_')}`;

    const putURL = await signPutUrl({
      bucket: process.env.R2_BUCKET,
      key,
      contentType: contentType || 'application/octet-stream',
      expiresSec: 900
    });

    const file = addFile({
      transferId: transfer.id,
      key,
      filename,
      size: Number(size),
      contentType: contentType || 'application/octet-stream'
    });

    res.json({
      ok: true,
      transferId: transfer.id,
      fileId: file.id,
      key,
      uploadUrl: putURL
    });
  } catch (e) {
    console.error('presign error', e);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// 2) COMMIT uploaded file (after client PUT)
app.post('/api/commit', async (req, res) => {
  try {
    const token = tokenFrom(req);
    const { fileId } = req.body || {};
    required(fileId, 'fileId');
    const info = finalizeFile(fileId, token);
    res.json({ ok: true, ...info });
  } catch (e) {
    console.error('commit error', e);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// 3) SHARE: returns /s/:code short link
app.post('/api/share', (req, res) => {
  try {
    const token = tokenFrom(req);
    const { transferId } = req.body || {};
    required(transferId, 'transferId');
    const code = ensureCode(transferId, token);
    res.json({ ok: true, code, url: `/s/${code}` });
  } catch (e) {
    console.error('share error', e);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// 4) Resolve short link
app.get('/s/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const tr = getTransferByCode(code);
    if (!tr) return res.status(404).json({ ok:false, error:'Not found' });
    // list files
    const rows = db.prepare('SELECT id, key, filename, size, content_type FROM files WHERE transfer_id=?').all(tr.id);
    res.json({ ok:true, transfer: { id: tr.id, ttlDays: tr.ttl_days, createdAt: tr.created_at, code }, files: rows });
  } catch (e) {
    console.error('s/:code error', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// 5) Temporary read link for a specific key
app.get('/api/readlink', async (req, res) => {
  try {
    const { key, ttl } = req.query;
    required(key, 'key');
    const expiresSec = clamp(parseInt(ttl || '300',10), 60, 3600);
    const url = await signGetUrl({
      bucket: process.env.R2_BUCKET,
      key,
      expiresSec
    });
    res.json({ ok:true, url });
  } catch (e) {
    console.error('readlink error', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

const PORT = parseInt(process.env.PORT || "10000", 10);
app.listen(PORT, () => {
  console.log(`Mixtli Transfer on :${PORT}`);
});