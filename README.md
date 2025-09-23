
# Mixtli Transfer Backend

Express backend listo para Render/Node que genera URLs firmadas (presigned) para subir archivos directamente a un storage S3‑compatible (Cloudflare R2).

## Endpoints

- `GET /salud` — Health check.
- `POST /api/presign` — Crea un **PUT presign** para subir directo a R2.
  - Body JSON: `{ "filename": "ejemplo.jpg", "contentType": "image/jpeg" }`
  - Respuesta: `{ ok, key, url, expiresAt }`

## Variables de entorno

Copiar `.env.example` a `.env` y llenar:

```env
PORT=10000
ALLOWED_ORIGINS=["http://localhost:5173"]

UPLOAD_PREFIX=uploads/

S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_BUCKET=<tu-bucket>
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=<tu-access-key-id>
S3_SECRET_ACCESS_KEY=<tu-secret>
PRESIGN_EXPIRES=900
```

> **Notas R2:** Usa **S3 API Tokens** (Access Key ID y Secret) de Cloudflare R2. El endpoint **no** lleva el nombre del bucket en la URL; eso va en `S3_BUCKET`.

## Deploy en Render

1. Crea un nuevo **Web Service** (Node).
2. Build Command: `npm install --no-audit --no-fund`
3. Start Command: `node server.js`
4. Node 18+.
5. Añade las variables de entorno arriba.
6. Verifica `GET /salud` en logs y en el navegador.

## Ejemplo de uso (front)

```js
const r = await fetch("https://TU-BACKEND.onrender.com/api/presign", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename: file.name, contentType: file.type })
});
const data = await r.json();
// Luego subir directo:
await fetch(data.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
```

---

_Folder generado: 2025-09-23T23:12:24.227969Z_
