// Mixtli Backend v2 — persistente (SQLite + Rate limit + Cleanup)
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

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'mixtli.sqlite');

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

let db;
async function initDb(){
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS links (
    token TEXT PRIMARY KEY,
    s3key TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_links_expires ON links (expiresAt);`);
}
function nowSec(){ return Math.floor(Date.now()/1000); }
const sanitizeName = (name='') => name.replace(/[^\w.\-]+/g, '_').slice(0, 180);
const genId = (n=16) => crypto.randomBytes(n).toString('base64url');

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
app.use((req,res,next)=>{
  if(!REQUIRE_TOKEN) return next();
  const t = req.header('x-mixtli-token');
  if (t && t===process.env.MIXTLI_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'missing or invalid x-mixtli-token' });
});

const limiter = rateLimit({ windowMs: Number(process.env.RATE_WINDOW_MS||60000), max: Number(process.env.RATE_MAX||60), standardHeaders:true, legacyHeaders:false });
app.use(['/api/presign','/api/list','/api/readlink'], limiter);

app.get('/salud', (req,res)=> res.type('text').send('ok'));

app.post('/api/presign', async (req,res)=>{
  try{
    const { name, size, type, mode } = req.body||{};
    if(!name || typeof size!=='number') return res.status(400).json({ ok:false, error:'name/size required' });
    if(!BUCKET || !process.env.S3_ENDPOINT) return res.status(500).json({ ok:false, error:'S3 config missing' });

    const MAX_BYTES = Number(process.env.MAX_BYTES || (2*1024*1024*1024));
    if(size > MAX_BYTES) return res.status(413).json({ ok:false, error:`size exceeds limit ${MAX_BYTES}` });

    const safe = sanitizeName(String(name));
    const prefix = mode === 'cloud' ? 'cloud' : 'link';
    const key = `${prefix}/${new Date().toISOString().slice(0,10)}/${genId(8)}-${safe}`;

    const contentType = type || 'application/octet-stream';
    const url = await getSignedUrl(S3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: 60*15 });

    const resp = { ok:true, url, headers:{ 'Content-Type': contentType } };
    if(prefix==='link'){
      const token = genId(18);
      const ttlDays = Number(process.env.LINK_TTL_DAYS || 7);
      const expiresAt = nowSec() + ttlDays*24*60*60;
      await db.run(`INSERT OR REPLACE INTO links(token,s3key,expiresAt) VALUES(?,?,?)`, token, key, expiresAt);
      resp.token = token;
      resp.expiresAt = new Date(expiresAt*1000).toISOString();
    }
    res.json(resp);
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

app.get('/api/list', async (req,res)=>{
  try{
    const Prefix = 'cloud/';
    let files=[], ContinuationToken;
    do{
      const out = await S3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, MaxKeys: 200, ContinuationToken }));
      (out.Contents||[]).forEach(o=>{
        if(!o.Key || o.Key.endsWith('/')) return;
        const name = o.Key.split('/').slice(2).join('/') || o.Key;
        files.push({ key:o.Key, name, size:Number(o.Size||0) });
      });
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    }while(ContinuationToken && files.length<200);

    const signed = await Promise.all(files.map(async f=>{
      try{
        const head = await S3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: f.key }));
        const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: f.key }), { expiresIn: 3600 });
        return { ...f, contentType: head.ContentType||null, url };
      }catch{ return f; }
    }));
    res.json({ ok:true, files: signed });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

app.get('/api/readlink', async (req,res)=>{
  try{
    const token = (req.query.token||req.query.t||'').toString();
    if(!token) return res.status(400).json({ ok:false, error:'token required' });
    const row = await db.get(`SELECT token,s3key,expiresAt FROM links WHERE token=?`, token);
    if(!row) return res.status(404).json({ ok:false, error:'token not found' });
    if(row.expiresAt <= nowSec()){ await db.run(`DELETE FROM links WHERE token=?`, token); return res.status(410).json({ ok:false, error:'token expired' }); }
    const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: row.s3key }), { expiresIn: 300 });
    res.json({ ok:true, url, key: row.s3key, expiresIn: 300 });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

app.get('/s/:token', async (req,res)=>{
  try{
    const token = req.params.token;
    const row = await db.get(`SELECT token,s3key,expiresAt FROM links WHERE token=?`, token);
    if(!row) return res.status(404).type('text').send('Link no encontrado');
    if(row.expiresAt <= nowSec()){ await db.run(`DELETE FROM links WHERE token=?`, token); return res.status(410).type('text').send('Link expirado'); }
    const url = await getSignedUrl(S3, new GetObjectCommand({ Bucket: BUCKET, Key: row.s3key }), { expiresIn: 300 });
    res.redirect(302, url);
  }catch(e){ console.error(e); res.status(500).type('text').send('Error al generar link'); }
});

// limpieza periódica
setInterval(async ()=>{
  try{
    const removed = await db.run(`DELETE FROM links WHERE expiresAt <= ?`, nowSec());
    if(removed && removed.changes) console.log(`[cleanup] removed ${removed.changes}`);
  }catch(e){ console.error('[cleanup]', e); }
}, CLEANUP_INTERVAL_MIN*60*1000);

(async ()=>{
  await initDb();
  app.listen(PORT, ()=> console.log(`Mixtli Backend v2 on :${PORT} (db=${DB_PATH})`));
})();
