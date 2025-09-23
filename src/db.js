// src/db.js
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'mixtli.sqlite');

const db = new sqlite3.Database(DB_PATH);

function initDB() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS transfers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_days INTEGER NOT NULL DEFAULT 7,
      code TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS files(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_type TEXT,
      done INTEGER NOT NULL DEFAULT 0
    )`);
  });
}

function run(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){
      if (err) reject(err); else resolve(this);
    });
  });
}
function get(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function(err, row){
      if (err) reject(err); else resolve(row);
    });
  });
}
function all(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function(err, rows){
      if (err) reject(err); else resolve(rows);
    });
  });
}

function createTransfer({ userToken, ttlDays }) {
  const createdAt = Math.floor(Date.now() / 1000);
  const stmt = db.prepare('INSERT INTO transfers(user_token, created_at, ttl_days) VALUES(?,?,?)');
  const info = stmt.run(userToken, createdAt, ttlDays);
  const id = info.lastID;
  return { id, userToken, createdAt, ttlDays };
}

function addFile({ transferId, key, filename, size, contentType }) {
  const stmt = db.prepare('INSERT INTO files(transfer_id, key, filename, size, content_type, done) VALUES(?,?,?,?,?,0)');
  const info = stmt.run(transferId, key, filename, size, contentType);
  return { id: info.lastID, transferId, key, filename, size, contentType };
}

function finalizeFile(fileId, userToken) {
  const row = db.prepare(`
    SELECT f.id, f.transfer_id AS transferId, t.user_token AS token
    FROM files f JOIN transfers t ON f.transfer_id = t.id
    WHERE f.id = ?
  `).get(fileId);
  if (!row) {
    const e = new Error('file not found'); e.status=404; throw e;
  }
  if (row.token !== userToken) {
    const e = new Error('forbidden'); e.status=403; throw e;
  }
  db.prepare('UPDATE files SET done = 1 WHERE id = ?').run(fileId);
  return { fileId };
}

function ensureCode(transferId, userToken) {
  const tr = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId);
  if (!tr) { const e = new Error('transfer not found'); e.status=404; throw e; }
  if (tr.user_token !== userToken) { const e = new Error('forbidden'); e.status=403; throw e; }
  if (tr.code) return tr.code;
  const code = Math.random().toString(36).slice(2, 8);
  db.prepare('UPDATE transfers SET code = ? WHERE id = ?').run(code, transferId);
  return code;
}

function getTransferByCode(code) {
  return db.prepare('SELECT * FROM transfers WHERE code = ?').get(code);
}

module.exports = { db, initDB, createTransfer, addFile, finalizeFile, ensureCode, getTransferByCode };