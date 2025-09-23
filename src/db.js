// src/db.js
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "mixtli.sqlite");

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free',
    createdAt INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS links(
    token TEXT PRIMARY KEY,
    userId TEXT,
    s3key TEXT NOT NULL,
    sizeBytes INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cloud_files(
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    s3key TEXT NOT NULL,
    sizeBytes INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS storage_wallet(
    userId TEXT PRIMARY KEY,
    baseBytes INTEGER NOT NULL,
    addonBytes INTEGER NOT NULL DEFAULT 0,
    usedBytes INTEGER NOT NULL DEFAULT 0
  )`);
});

module.exports = { db };
