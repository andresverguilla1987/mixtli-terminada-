// server.js (root)
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { nanoid } = require("nanoid");
const { db } = require("./src/db");
const {
  primary,
  PRIMARY_BUCKET,
  linkStore,
  LINK_BUCKET,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require("./src/storage");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(morgan("tiny"));

// CORS fino sin paquete (para no duplicar config con cors())
const ALLOWED = (() => {
  try { return JSON.parse(process.env.ALLOWED_ORIGINS || "[]"); } catch { return []; }
})();
function isAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED.includes(origin)) return true;
  if (process.env.ALLOW_NETLIFY_WILDCARD === "true" && /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) return true;
  return false;
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-mixtli-token");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// proxy awareness
app.set("trust proxy", 1);
const limiter = rateLimit({ windowMs: 60_000, limit: 300 });
app.use(limiter);

// helpers
const nowSec = () => Math.floor(Date.now() / 1000);
const BYTES = (gb) => BigInt(gb) * 1024n * 1024n * 1024n;

const LINK_TTL_DAYS = Number(process.env.LINK_TTL_DAYS || 7);
const FREE_CLOUD_RETENTION_DAYS = Number(process.env.FREE_CLOUD_RETENTION_DAYS || 30);

const PLANS = {
  free: {
    storage: BYTES(Number(process.env.PLAN_FREE_STORAGE_GB || 5)),
    maxTransfer: 3n * 1024n * 1024n * 1024n,
    priceMonthCents: 0,
  },
  lite: {
    storage: BYTES(Number(process.env.PLAN_LITE_STORAGE_GB || 100)),
    maxTransfer: 300n * 1024n * 1024n * 1024n,
    priceMonthCents: Number(process.env.PRICE_LITE_MONTH_CENTS || 149),
  },
  pro: {
    storage: BYTES(Number(process.env.PLAN_PRO_STORAGE_GB || 1024)),
    maxTransfer: 300n * 1024n * 1024n * 1024n,
    priceMonthCents: Number(process.env.PRICE_PRO_MONTH_CENTS || 699),
  },
  max: {
    storage: BYTES(Number(process.env.PLAN_MAX_STORAGE_GB || 5120)),
    maxTransfer: 300n * 1024n * 1024n * 1024n,
    priceMonthCents: Number(process.env.PRICE_MAX_MONTH_CENTS || 899),
  },
};

async function ensureUser(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT id, plan FROM users WHERE id=?", userId, (err, row) => {
      if (err) return reject(err);
      if (row) return resolve(row);
      const createdAt = nowSec();
      db.run("INSERT INTO users(id,plan,createdAt) VALUES(?,?,?)", userId, "free", createdAt, (e) => {
        if (e) return reject(e);
        resolve({ id: userId, plan: "free" });
      });
    });
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, provider: process.env.STORAGE_PROVIDER, linkProvider: process.env.LINK_PROVIDER });
});

app.get("/api/me/plan", async (req, res) => {
  const userId = req.headers["x-mixtli-token"] || "anon-" + req.ip;
  await ensureUser(userId);
  db.get("SELECT plan FROM users WHERE id=?", userId, (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    const plan = row?.plan || "free";
    const p = PLANS[plan];
    db.get("SELECT baseBytes, addonBytes, usedBytes FROM storage_wallet WHERE userId=?", userId, (e, w) => {
      const baseBytes = w?.baseBytes || Number(p.storage.toString());
      const addonBytes = w?.addonBytes || 0;
      const usedBytes = w?.usedBytes || 0;
      res.json({
        ok: true,
        plan,
        storageBytes: String(baseBytes + addonBytes),
        usedBytes: String(usedBytes),
        maxTransferBytes: String(p.maxTransfer),
      });
    });
  });
});

app.post("/api/presign", async (req, res) => {
  try {
    const { mode, filename, size } = req.body || {};
    const userId = req.headers["x-mixtli-token"] || "anon-" + req.ip;
    const u = await ensureUser(userId);
    const plan = u.plan || "free";
    const p = PLANS[plan];
    const fileId = require("nanoid").nanoid(12);
    const keyPrefix = mode === "cloud"
      ? (plan === "free" ? `cloud/free/${userId}/` : `cloud/perm/${userId}/`)
      : `link/${userId}/`;
    const s3key = keyPrefix + fileId + "-" + (filename || "file.bin");

    const sizeBig = BigInt(size || 0);
    if (mode === "link" && sizeBig > p.maxTransfer) {
      return res.status(413).json({ ok: false, error: "Archivo supera el máximo por link para tu plan." });
    }
    if (mode === "cloud") {
      db.get("SELECT baseBytes, addonBytes, usedBytes FROM storage_wallet WHERE userId=?", userId, (e, w) => {
        const cap = BigInt(w?.baseBytes || p.storage) + BigInt(w?.addonBytes || 0);
        const used = BigInt(w?.usedBytes || 0);
        if (used + sizeBig > cap) return res.status(403).json({ ok: false, error: "Sin espacio en tu nube." });
        return res.json({
          ok: true,
          provider: process.env.STORAGE_PROVIDER,
          bucket: PRIMARY_BUCKET,
          key: s3key,
          fileId,
        });
      });
      return;
    }
    // link
    return res.json({
      ok: true,
      provider: process.env.LINK_PROVIDER,
      bucket: LINK_BUCKET,
      key: s3key,
      fileId,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/commit", async (req, res) => {
  try {
    const { mode, key, fileId, size } = req.body || {};
    const userId = req.headers["x-mixtli-token"] || "anon-" + req.ip;
    const u = await ensureUser(userId);
    const plan = u.plan || "free";
    const now = nowSec();

    if (mode === "link") {
      const expiresAt = now + (Number(process.env.LINK_TTL_DAYS || 7) * 86400);
      db.run(
        "INSERT INTO links(token,userId,s3key,sizeBytes,createdAt,expiresAt) VALUES(?,?,?,?,?,?)",
        fileId, userId, key, Number(size || 0), now, expiresAt,
        (e) => {
          if (e) return res.status(500).json({ ok: false, error: e.message });
          res.json({ ok: true, token: fileId, expiresAt });
        }
      );
      return;
    }

    let expiresAt = null;
    if (plan === "free") expiresAt = now + (Number(process.env.FREE_CLOUD_RETENTION_DAYS || 30) * 86400);

    db.run(
      "INSERT INTO cloud_files(id,userId,s3key,sizeBytes,createdAt,expiresAt) VALUES(?,?,?,?,?,?)",
      fileId, userId, key, Number(size || 0), now, expiresAt,
      (e) => {
        if (e) return res.status(500).json({ ok: false, error: e.message });
        db.run(
          "INSERT INTO storage_wallet(userId,baseBytes,addonBytes,usedBytes) VALUES(?,?,?,?) ON CONFLICT(userId) DO UPDATE SET usedBytes=usedBytes+excluded.usedBytes",
          userId, Number(PLANS[plan].storage.toString()), 0, Number(size || 0),
          (e2) => {
            if (e2) return res.status(500).json({ ok: false, error: e2.message });
            res.json({ ok: true, id: fileId, expiresAt });
          }
        );
      }
    );
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function cleanup() {
  const now = nowSec();
  // links
  db.all("SELECT token, s3key FROM links WHERE expiresAt <= ?", now, async (e, rows) => {
    if (!e && rows?.length) {
      for (const r of rows) {
        try {
          await linkStore.send(new DeleteObjectCommand({ Bucket: LINK_BUCKET, Key: r.s3key }));
        } catch (err) {
          console.warn("delete link failed", r.s3key, err?.name);
        }
      }
      db.run("DELETE FROM links WHERE expiresAt <= ?", now, () => {});
    }
  });
  // free cloud
  db.all("SELECT id,s3key,userId,sizeBytes FROM cloud_files WHERE expiresAt IS NOT NULL AND expiresAt <= ?", now, async (e, rows) => {
    if (!e && rows?.length) {
      for (const r of rows) {
        try {
          await primary.send(new DeleteObjectCommand({ Bucket: PRIMARY_BUCKET, Key: r.s3key }));
        } catch (err) {
          console.warn("delete free cloud failed", r.s3key, err?.name);
        }
        db.run("UPDATE storage_wallet SET usedBytes = MAX(0, usedBytes - ?) WHERE userId=?", Number(r.sizeBytes || 0), r.userId, () => {});
      }
      db.run("DELETE FROM cloud_files WHERE expiresAt IS NOT NULL AND expiresAt <= ?", now, () => {});
    }
  });
}
setInterval(cleanup, 10 * 60 * 1000);

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`Mixtli Backend fix-min on :${port}`);
});
