# Mixtli Backend v2 (SQLite + Rate limit + Cleanup)
Deploy:
- Build: `npm ci --omit=dev --no-audit --no-fund`
- Start: `node server.js`
- Monta un disk en Render y define `DATA_DIR=/data` para persistencia.

Netlify `_redirects`:
/s/*   https://TU-BACKEND.onrender.com/s/:splat   200
/api/* https://TU-BACKEND.onrender.com/api/:splat 200
/salud https://TU-BACKEND.onrender.com/salud      200

R2 CORS:
[
  {
    "AllowedOrigins": ["https://TU-SITIO.netlify.app"],
    "AllowedMethods": ["PUT","GET","HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 86400
  }
]
