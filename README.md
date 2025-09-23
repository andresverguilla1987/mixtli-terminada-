# Mixtli · Monorepo (Frontend + Backend + Scripts)

## Estructura
- `/frontend` → Netlify (estático) con UI y diagnóstico CORS
- `/backend`  → Render (Node) con SQLite, rate limit, cleanup y `/s/:token`
- `/scripts`  → backup `mixtli.sqlite` a R2
- `/infra`    → `r2_lifecycle.json` (expira `link/` a 7d)

## Despliegue rápido

### 1) Backend en Render
- **Build:** `npm ci --omit=dev --no-audit --no-fund`
- **Start:** `node server.js`
- **Disk (recomendado):** monta un Disk y define `DATA_DIR=/data` (o usa `/opt/render/project/src/data` sin persistencia).
- **Env requeridas:**
  - `ALLOWED_ORIGINS=["https://TU-SITIO.netlify.app"]`
  - `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
  - `S3_BUCKET=<tu-bucket>`
  - `S3_REGION=auto`
  - `S3_FORCE_PATH_STYLE=true`
  - `S3_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>`
  - `S3_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>`

### 2) Frontend en Netlify
- Sube `/frontend` tal cual.
- `_redirects` ya incluye:
  ```
  /s/*   https://TU-BACKEND.onrender.com/s/:splat   200
  /api/* https://TU-BACKEND.onrender.com/api/:splat 200
  /salud https://TU-BACKEND.onrender.com/salud      200
  ```

### 3) CORS en R2
En **Cloudflare R2 → bucket → Settings → CORS** pega:
```json
[
  {
    "AllowedOrigins": ["https://TU-SITIO.netlify.app"],
    "AllowedMethods": ["PUT","GET","HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 86400
  }
]
```

### 4) Lifecycle en R2
En **Settings → Lifecycle** pega el contenido de `/infra/r2_lifecycle.json`.

### 5) Backups (Render Scheduled Job)
- Job Node con repo apuntando a este monorepo.
- **Command:** `node scripts/backup_r2.js`
- **Schedule:** `0 7 * * 1`
- **Env:** `DATA_DIR=/data` y credenciales R2 como en el backend.

## Pruebas rápidas
- **Salud:** `GET https://TU-BACKEND.onrender.com/salud` → `ok`
- **Subida:** desde el front, sube un archivo → presign 200 → PUT 200.
- **Link:** copia `/s/<token>` → debe hacer 302 a R2.
