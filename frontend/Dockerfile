# =============================================================================
# Frontend — Mercado Agrícola.
# Servido por Nginx con archivos pre-construidos en el host.
# =============================================================================

FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html

EXPOSE 80
