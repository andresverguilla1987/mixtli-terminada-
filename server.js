// server.js
// Mixtli Backend (R2/B2 presign PUT con URL firmada + commit en SQLite)

const express = require("express");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

// --- AWS SDK v3 (S3 + signer)
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// --- SQLite (archivo local, no /data para evitar EACCES en Render)
const sqlite3 = require("sqlite3").verbose();

// =========================
// Config básica
// =========================
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || "production";

// Crea carpeta ./data si no existe
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "mixtli.sqlite");

// =========================
// DB
// =========================
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      key TEXT NOT NULL,
      size INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
});

// =========================
/**
 * S3 client segun proveedor (R2/B2)
 * Env esperados:
 *   STORAGE_PROVIDER = r2 | b2
 *
 *   R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *   R2_BUCKET=mixtli-bucket
 *   R2_ACCESS_KEY_ID=***
 *   R2_SECRET_ACCESS_KEY=***
 *
 *   B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
 *   B2_BUCKET=mixtli-bucket
 *   B2_ACCESS_KEY_ID=***
 *   B2_SECRET_ACCESS_KEY=***
 *   B2_REGION=us-east-005    (opcional)
 */
// =========================
function makeS3ForPresign() {
  const provider = (process.env.STORAGE_PROVIDER || "r2").toLowerCase();

  if (provider === "r2") {
    const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
      throw new Error("Variables R2 incompletas (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET)");
    }
    return {
      s3: new S3Client({
        region: "auto",
        endpoint: R2_ENDPOINT,
        forcePathStyle: false,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      }),
      bucket: R2_BUCKET,
    };
  }

  if (provider === "b2") {
    const {
      B2_ENDPOINT,
      B2_ACCESS_KEY_ID,
      B2_SECRET_ACCESS_KEY,
      B2_BUCKET,
      B2_REGION = "us-east-005",
    } = process.env;
    if (!B2_ENDPOINT || !B2_ACCESS_KEY_ID || !B2_SECRET_ACCESS_KEY || !B2_BUCKET) {
      throw new Error("Variables B2 incompletas (B2_ENDPOINT/B2_ACCESS_KEY_ID/B2_SECRET_ACCESS_KEY/B2_BUCKET)");
    }
    return {
      s3: new S3Client({
        region: B2_REGION,
        endpoint: B2_ENDPOINT,
        forcePathStyle: false,
        credentials: { accessKeyId: B2_ACCESS_KEY_ID, secretAccessKey: B2_SECRET_ACCESS_KEY },
      }),
      bucket: B2_BUCKET,
    };
  }

  throw new Error("STORAGE_PROVIDER inválido (usa r2 o b2)");
}

// =========================
// App
// =========================
const app = express();

// Confianza en el proxy (Render) para que rate-limit no truene con X-Forwarded-For
app.set("trust proxy", 1);

// Logs
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

// Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

// =========================
// CORS manual (whitelist por env)
// =========================
const ALLOWED_ORIGINS = (() => {
  try {
    return JSON.parse(process.env.ALLOWED_ORIGINS || "[]"); // ej: ["https://tu-sitio.netlify.app"]
  } catch {
    return [];
  }
})();

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // wildcard opcional para deploy previews de Netlify
  if (
    process.env.ALLOW_NETLIFY_WILDCARD === "true" &&
    /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)
  ) {
    return true;
  }
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-mixtli-token");
  // Si vas a usar cookies/sesiones:
  // res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

// =========================
// Rate limit básico
// =========================
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// =========================
// Rutas básicas
// =========================
app.get("/", (req, res) => {
  res.type("text/plain").send("Mixtli Backend • OK");
});
app.head("/", (req, res) => res.status(200).end());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/version", (req, res) => {
  res.json({
    name: "Mixtli Backend",
    version: process.env.BUILD_VERSION || "fix-min",
    provider: process.env.STORAGE_PROVIDER || "r2",
  });
});

// Simples “planes” por token demo
app.get("/api/me/plan", (req, res) => {
  const userId = req.headers["x-mixtli-token"] || "anon";
  // Demo: si es user123 → free 5GB; cualquier otro → free 5GB
  const plan = {
    userId,
    tier: "free",
    quotaGB: 5,
    usedGB: 0,
    expiresAt: null,
  };
  res.json(plan);
});

// =========================
// PRESIGN: devuelve URL firmada para PUT
// =========================
app.post("/api/presign", async (req, res) => {
  try {
    const userId = req.headers["x-mixtli-token"] || "anon";
    const { mode, filename, size, contentType } = req.body || {};
    if (mode !== "link") return res.status(400).json({ ok: false, error: "mode inválido" });
    if (!filename || typeof filename !== "string") return res.status(400).json({ ok: false, error: "filename requerido" });
    if (typeof size !== "number" || !(size >= 0)) return res.status(400).json({ ok: false, error: "size requerido (number)" });

    const { s3, bucket } = makeS3ForPresign();

    const rand = Math.random().toString(36).slice(2, 10);
    const safeName = filename.replace(/[^\w.\-]/g, "_");
    const key = `link/${userId}/${rand}-${safeName}`;

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 10 }); // 10 min

    const fileId = rand;
    return res.json({ ok: true, url, key, fileId, bucket });
  } catch (err) {
    console.error("presign error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

// =========================
/**
 * COMMIT: guarda registro en SQLite (llámalo después del PUT)
 * body: { mode: "link", key, fileId, size }
 */
// =========================
app.post("/api/commit", (req, res) => {
  try {
    const userId = req.headers["x-mixtli-token"] || "anon";
    const { mode, key, fileId, size } = req.body || {};
    if (mode !== "link") return res.status(400).json({ ok: false, error: "mode inválido" });
    if (!key) return res.status(400).json({ ok: false, error: "key requerido" });
    if (!fileId) return res.status(400).json({ ok: false, error: "fileId requerido" });
    if (typeof size !== "number" || !(size >= 0)) return res.status(400).json({ ok: false, error: "size inválido" });

    const createdAt = Date.now();

    db.run(
      "INSERT INTO uploads (id, userId, key, size, createdAt) VALUES (?, ?, ?, ?, ?)",
      [fileId, userId, key, size, createdAt],
      (err) => {
        if (err) {
          console.error("commit db error:", err);
          return res.status(500).json({ ok: false, error: "db insert error" });
        }
        return res.json({ ok: true, token: fileId, key, size, createdAt });
      }
    );
  } catch (err) {
    console.error("commit error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

// =========================
// 404
// =========================
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not Found" });
});

// =========================
// Start
// =========================
app.listen(PORT, () => {
  console.log(`Mixtli Backend fix-min root on :${PORT}`);
});
