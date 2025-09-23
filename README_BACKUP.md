# Mixtli · Paquete de Extras (Backups + Lifecycle + Per-plan)

## 1) Backups automáticos a R2
- `scripts/backup_r2.js`: comprime `DATA_DIR/mixtli.sqlite` y lo sube a `backups/YYYY/MM/...` en tu bucket R2.

### Render (Cron Job)
- Command: `node scripts/backup_r2.js`
- Schedule: `0 7 * * 1`
- Env: `DATA_DIR=/data`, `R2_BACKUP_BUCKET=mixtli-backups`, `S3_*` con tus credenciales.

## 2) Lifecycle en Cloudflare R2
Pega `r2_lifecycle.json` en **R2 → bucket → Settings → Lifecycle**:
- Expira `link/` a los 7 días.
- Aborta multiparts incompletos a los 7 días.

## 3) Rate limits por plan (idea)
Define en env:
```
PLAN_LIMITS_JSON='{"free":{"RATE_MAX":30,"MAX_BYTES":268435456},"pro":{"RATE_MAX":120,"MAX_BYTES":2147483648}}'
```
Luego lee `x-mixtli-plan` en tu middleware para decidir límites.
