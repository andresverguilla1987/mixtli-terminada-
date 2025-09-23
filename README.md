# Mixtli Transfer (solo transferencias)

Backend minimal tipo WeTransfer para Render + Cloudflare R2.

## Endpoints
- `POST /api/presign` → crea transferencia y devuelve `uploadUrl` firmado para PUT directo a R2
- `POST /api/commit` → marca archivo como terminado
- `POST /api/share` → devuelve `code` y url `/s/:code`
- `GET /s/:code` → lista archivos de esa transferencia
- `GET /api/readlink?key=...` → URL temporal firmado para descarga

Cabezera obligatoria: `x-mixtli-token` (identifica al usuario/sesión).

## CORS del bucket (R2)
Configura en Cloudflare R2:
```json
[
  {
    "AllowedOrigins": ["https://tu-sitio.netlify.app","http://localhost:8080"],
    "AllowedMethods": ["PUT","GET","HEAD","OPTIONS"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["etag","content-length"],
    "MaxAgeSeconds": 86400
  }
]
```

## Render
Start command:
```
npm install --omit=dev --no-audit --no-fund && npm start
```