# Mixtli — Backend (Barato + Egress)
Combo **B2 (barato)** para la nube + **R2 (egress $0)** para links de 7 días.

## 1) Configurar buckets
- **Backblaze B2** (S3 compatible):
  - Bucket: `mixtli-cloud`
  - Prefijos:
    - `cloud/perm/**` → *sin caducidad* (planes pagos)
    - `cloud/free/**` → *delete after 30 days* (lifecycle rule)
- **Cloudflare R2**:
  - Bucket: `mixtli-links`
  - Prefijo: `link/**` → *delete after 7 days* (lifecycle)

## 2) .env
Copia `.env.example` a `.env` y pon tus keys/endpoint.

## 3) Ejecutar
```bash
npm install
npm start
```
El server queda en `:10000`.

## 4) Endpoints
- `GET /api/health`
- `GET /api/me/plan`
- `POST /api/presign` body: `{ mode: "link"|"cloud", filename, size }`
- `POST /api/commit` body: `{ mode, key, fileId, size }`
- `POST /api/upgrade` body: `{ plan: "lite"|"pro"|"max" }`

## 5) Notas
- CORS: usa `ALLOWED_ORIGINS` en `.env`.
- `cleanup` corre cada 10 min y además los buckets tienen lifecycle.
- Este backend no firma URLs presignadas; te devuelve `bucket` + `key` y tú subes con `PUT` directo si tu bucket lo permite o puedes añadir firma con `@aws-sdk/s3-request-presigner` si prefieres.
