# Mixtli Mini Backend (limpio)

Backend Express con endpoints:
- `GET /salud`
- `POST /api/presign` → presign PUT a S3/R2
- `GET /api/list`     → lista `cloud/` y devuelve URLs firmadas de lectura

## Deploy en Render
1. Crear nuevo servicio **Web** (Node).
2. Variables de entorno (Dashboard → Environment):
   - `ALLOWED_ORIGINS`: `["https://TU-SITIO.netlify.app","http://localhost:8888"]`
   - (Opcional) `ALLOW_NETLIFY_WILDCARD=true`
   - (Opcional) `MIXTLI_TOKEN=...` si deseas exigir `x-mixtli-token`
   - `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`
   - `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
3. **Build Command**: `npm ci --omit=dev --no-audit --no-fund`
4. **Start Command**: `node server.js`

## Notas
- Prefijos:
  - En modo link, los archivos se guardan bajo `link/yyyy-mm-dd/...` y genera `token` (guardado en memoria). En producción usa DB.
  - En modo nube, se guardan bajo `cloud/yyyy-mm-dd/...`.
- El frontend de ejemplo (ZIP v2) es compatible con esta API.
