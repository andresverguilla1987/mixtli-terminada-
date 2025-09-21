# Mixtli Mini Backend v1.1
Novedades:
- `GET /s/:token` → redirige (302) a un URL firmado de lectura (válido 5 min).
- `GET /api/readlink?token=...` → devuelve JSON con el URL firmado.

## Netlify rewrites
Para que tus links `https://TU-SITIO.netlify.app/s/<token>` funcionen, añade en `_redirects` del front:
```
/s/*  https://TU-BACKEND.onrender.com/s/:splat  200
```
