// Mixtli Mini v1.15.3 — backend listo para producción
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fetch from 'node-fetch';
import sharp from 'sharp';
import sqlite3pkg from 'sqlite3';
import { open } from 'sqlite';
import rateLimit from 'express-rate-limit';

const {
  PORT = 10000, NODE_ENV = 'production',
  JWT_SECRET = '',
  ALLOWED_ORIGINS = '["*"]',
  SQLITE_FILE = './mixtli.db',
  S3_ENDPOINT, S3_REGION = 'auto', S3_BUCKET,
  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE = 'true',
  DEFAULT_READ_TTL = '300', THUMB_DEFAULT_WIDTH = '480', SHARE_DEFAULT_TTL_DAYS = '7',
  RATE_LIMIT_ENABLED = 'true', RATE_LIMIT_WINDOW_MS = '60000', RATE_LIMIT_MAX = '120',
  REQUEST_LOGS = 'true',
} = process.env;

const app = express();
app.use(express.json({ limit: '10mb' }));

let origins = [];
try { origins = JSON.parse(ALLOWED_ORIGINS); } catch { origins = ['*']; }
app.use(cors({
  origin: (o, cb) => (!o || origins.includes('*') || origins.includes(o)) ? cb(null, true) : cb(new Error('CORS blocked')),
}));
if (REQUEST_LOGS === 'true') app.use(morgan('dev'));
if (RATE_LIMIT_ENABLED === 'true') app.use(rateLimit({
  windowMs: parseInt(RATE_LIMIT_WINDOW_MS,10),
  max: parseInt(RATE_LIMIT_MAX,10), standardHeaders:true, legacyHeaders:false
}));

// DB
const sqlite3 = sqlite3pkg.verbose();
const db = await open({ filename: SQLITE_FILE, driver: sqlite3.Database });
await db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,passhash TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY AUTOINCREMENT,userId INTEGER, \`key\` TEXT UNIQUE NOT NULL,size INTEGER,contentType TEXT,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shares(id INTEGER PRIMARY KEY AUTOINCREMENT,\`key\` TEXT NOT NULL,token TEXT UNIQUE NOT NULL,expiresAt TEXT NOT NULL,createdAt TEXT NOT NULL);
`);

// S3
const s3Configured = !!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);
const s3 = s3Configured ? new S3Client({
  endpoint: S3_ENDPOINT, region: S3_REGION,
  forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
}) : null;

const nowISO = () => new Date().toISOString();
const requireAuth = (req,res,next)=>{
  if(!JWT_SECRET) return res.status(401).json({ok:false,error:'Auth disabled (missing JWT_SECRET)'});
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return res.status(401).json({ok:false,error:'No token'});
  try{ req.user=jwt.verify(token,JWT_SECRET); next(); }catch{ return res.status(401).json({ok:false,error:'Invalid token'}); }
};

app.get('/',(_,res)=>res.json({message:"Backend's ready to use"}));
app.get('/version',(_,res)=>res.json({ok:true,name:'Mixtli Mini',version:'1.15.3'}));
app.get('/api/health',(_,res)=>res.json({ok:true,auth:!!JWT_SECRET,s3:s3Configured,version:'1.15.3'}));

// Auth
app.post('/api/auth/register', async (req,res)=>{
  try{
    if(!JWT_SECRET) return res.status(400).json({ok:false,error:'JWT_SECRET missing'});
    const {email,password}=req.body||{}; if(!email||!password) return res.status(400).json({ok:false,error:'email/password required'});
    const passhash=await bcrypt.hash(password,10);
    await db.run('INSERT INTO users(email,passhash,createdAt) VALUES(?,?,?)',[email,passhash,nowISO()]);
    const row=await db.get('SELECT id,email FROM users WHERE email=?',[email]);
    const token=jwt.sign({id:row.id,email:row.email},JWT_SECRET,{expiresIn:'7d'});
    res.json({ok:true,token,user:row});
  }catch(e){ if(String(e).includes('UNIQUE')) return res.status(409).json({ok:false,error:'Email already exists'}); res.status(500).json({ok:false,error:'Register failed'}); }
});
app.post('/api/auth/login', async (req,res)=>{
  try{
    if(!JWT_SECRET) return res.status(400).json({ok:false,error:'JWT_SECRET missing'});
    const {email,password}=req.body||{}; const row=await db.get('SELECT * FROM users WHERE email=?',[email]);
    if(!row) return res.status(401).json({ok:false,error:'Invalid credentials'});
    const ok=await bcrypt.compare(password,row.passhash); if(!ok) return res.status(401).json({ok:false,error:'Invalid credentials'});
    const token=jwt.sign({id:row.id,email:row.email},JWT_SECRET,{expiresIn:'7d'});
    res.json({ok:true,token,user:{id:row.id,email:row.email}});
  }catch{ res.status(500).json({ok:false,error:'Login failed'}); }
});
app.get('/api/auth/me', requireAuth, async (req,res)=>{
  const u=await db.get('SELECT id,email,createdAt FROM users WHERE id=?',[req.user.id]);
  res.json({ok:true,user:u});
});

// Files
app.post('/api/presign', requireAuth, async (req,res)=>{
  try{
    if(!s3Configured) return res.status(500).json({ok:false,error:'S3 not configured'});
    const {filename,contentType='application/octet-stream'}=req.body||{};
    const safe=String(filename||'file').replace(/[^\w.\-]/g,'_');
    const key=`${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`;
    const cmd=new PutObjectCommand({Bucket:S3_BUCKET,Key:`mixtli/${key}`,ContentType:contentType});
    const url=await getSignedUrl(s3,cmd,{expiresIn:300});
    res.json({ok:true,key,url});
  }catch{ res.status(500).json({ok:false,error:'presign failed'}); }
});
app.post('/api/commit', requireAuth, async (req,res)=>{
  try{
    const {key,size=0,contentType=''}=req.body||{}; if(!key) return res.status(400).json({ok:false,error:'key required'});
    await db.run('INSERT OR IGNORE INTO assets(userId,`key`,size,contentType,createdAt) VALUES(?,?,?,?,?)',[req.user.id,key,size,contentType,nowISO()]);
    res.json({ok:true,key});
  }catch{ res.status(500).json({ok:false,error:'commit failed'}); }
});
app.get('/api/readlink', requireAuth, async (req,res)=>{
  try{
    if(!s3Configured) return res.status(500).json({ok:false,error:'S3 not configured'});
    const {key,ttl}=req.query; if(!key) return res.status(400).json({ok:false,error:'key required'});
    const seconds=parseInt(ttl||DEFAULT_READ_TTL,10);
    const cmd=new GetObjectCommand({Bucket:S3_BUCKET,Key:`mixtli/${key}`});
    const url=await getSignedUrl(s3,cmd,{expiresIn:seconds});
    res.json({ok:true,url,ttl:seconds});
  }catch{ res.status(500).json({ok:false,error:'readlink failed'}); }
});
app.post('/api/thumbnail', requireAuth, async (req,res)=>{
  try{
    if(!s3Configured) return res.status(500).json({ok:false,error:'S3 not configured'});
    const {key,width}=req.body||{}; if(!key) return res.status(400).json({ok:false,error:'key required'});
    const w=parseInt(width||THUMB_DEFAULT_WIDTH,10);
    const getCmd=new GetObjectCommand({Bucket:S3_BUCKET,Key:`mixtli/${key}`});
    const getUrl=await getSignedUrl(s3,getCmd,{expiresIn:120});
    const buf=Buffer.from(await (await fetch(getUrl)).arrayBuffer());
    const out=await sharp(buf).resize({width:w}).jpeg({quality:82}).toBuffer();
    const thumbKey=`thumb_${w}_${key.replace(/\//g,'_')}.jpg`;
    const putCmd=new PutObjectCommand({Bucket:S3_BUCKET,Key:`mixtli/${thumbKey}`,ContentType:'image/jpeg',Body:out});
    await s3.send(putCmd);
    res.json({ok:true,thumbnailKey:thumbKey});
  }catch{ res.status(500).json({ok:false,error:'thumbnail failed'}); }
});
app.post('/api/share', requireAuth, async (req,res)=>{
  try{
    const {key}=req.body||{}; if(!key) return res.status(400).json({ok:false,error:'key required'});
    const token=`${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const days=parseInt(SHARE_DEFAULT_TTL_DAYS,10);
    const expiresAt=new Date(Date.now()+days*86400000).toISOString();
    await db.run('INSERT INTO shares(`key`,token,expiresAt,createdAt) VALUES(?,?,?,?)',[key,token,expiresAt,new Date().toISOString()]);
    res.json({ok:true,url:`/s/${token}`,token,expiresAt});
  }catch{ res.status(500).json({ok:false,error:'share failed'}); }
});
app.get('/s/:token', async (req,res)=>{
  try{
    if(!s3Configured) return res.status(500).send('S3 not configured');
    const r=await db.get('SELECT `key`,expiresAt FROM shares WHERE token=?',[req.params.token]);
    if(!r) return res.status(404).send('Not found');
    if(new Date(r.expiresAt).getTime()<Date.now()) return res.status(410).send('Link expired');
    const cmd=new GetObjectCommand({Bucket:S3_BUCKET,Key:`mixtli/${r.key}`});
    const url=await getSignedUrl(s3,cmd,{expiresIn:300});
    res.redirect(url);
  }catch{ res.status(500).send('Share resolver failed'); }
});
app.delete('/api/file', requireAuth, async (req,res)=>{
  try{
    const {key}=req.query; if(!key) return res.status(400).json({ok:false,error:'key required'});
    await s3.send(new DeleteObjectCommand({Bucket:S3_BUCKET,Key:`mixtli/${key}`}));
    await db.run('DELETE FROM assets WHERE `key`=?',[key]);
    res.json({ok:true});
  }catch{ res.status(500).json({ok:false,error:'delete failed'}); }
});

app.listen(PORT, ()=> console.log(`Mixtli Mini 1.15.3 on :${PORT}`));
