# Mixtli Backend v2.2 — Fallback de DATA_DIR

Este `server.js` evita caerse si `DATA_DIR=/data` no existe o no tiene permisos en Render.

## Qué cambia
- Intenta crear `DATA_DIR` (por env o `./data`).
- Si falla `/data`, hace **fallback** a `./data` automáticamente (no persistente).
- `trust proxy` activado antes del rate limiter.

## Cómo usarlo
1. Reemplaza tu `server.js` con este.
2. Redeploy en Render.

### Persistencia (recomendada)
- En Render → **Disks** → **Add Disk** (1–2 GB) → **Mount Path:** `/data`.
- En env: `DATA_DIR=/data`.
- Redeploy: ahora la DB persiste en `/data/mixtli.sqlite`.

### Temporal (sin Disk)
- Deja `DATA_DIR` vacío o usa `DATA_DIR=/opt/render/project/src/data`.
- **OJO**: se perderá al redeploy.

## Pruebas
- `GET /salud` → `ok`.
- Flujos: `POST /api/presign` (200) → PUT a R2 (200) → `/s/:token` (302).
