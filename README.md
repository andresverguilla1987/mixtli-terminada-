# Mixtli Backend — FIX MIN
Arregla `Cannot find module 'sqlite'` usando **sqlite3** e incluye `server.js` en la **raíz**, como espera Render.

## Deploy
1) Sube este ZIP al repo de Render.
2) Configura `.env` (usa `.env.example`).
3) Start command: `npm install --omit=dev --no-audit --no-fund && npm start`
4) Health: `/api/health`

## Diferencias clave
- `server.js` en raíz -> `require("./src/db")` (sqlite3) y `require("./src/storage")`.
- Sin `require('sqlite')`. Dependencia correcta: `"sqlite3": "^5.1.7"`.
