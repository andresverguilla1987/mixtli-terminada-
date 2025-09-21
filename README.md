# Mixtli Backend v2.1 (sqlite3-only)
Arregla el error de Render: "No matching version found for sqlite@^4.2.2" eliminando la dependencia 'sqlite'.

Deploy en Render:
- Build: `npm ci --omit=dev --no-audit --no-fund`
- Start: `node server.js`
- (Opcional) monta un disk y define `DATA_DIR=/data`

Netlify `_redirects`:
/s/*   https://TU-BACKEND.onrender.com/s/:splat   200
/api/* https://TU-BACKEND.onrender.com/api/:splat 200
/salud https://TU-BACKEND.onrender.com/salud      200
