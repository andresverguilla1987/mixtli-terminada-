# Backend (Render)

## Deploy
- **Build:** `npm ci --omit=dev --no-audit --no-fund`
- **Start:** `node server.js`

## Persistencia
- Monta un **Disk** y define `DATA_DIR=/data`. Alternativa no persistente: `DATA_DIR=/opt/render/project/src/data`.

## Variables clave
- `ALLOWED_ORIGINS` → tu dominio Netlify exacto.
- `S3_*` → credenciales y endpoint de Cloudflare R2.
- (Opcional) `MIXTLI_TOKEN` si quieres proteger las APIs.

## Endpoints
- `POST /api/presign`
- `GET  /api/list`
- `GET  /api/readlink?token=...`
- `GET  /s/:token`
- `GET  /salud`
