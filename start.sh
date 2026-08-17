#!/bin/sh
set -eu

NGINX_PORT="${PORT:-3000}"
PANEL_PORT="${PANEL_PORT:-8090}"
DATA_DIR="${DATA_DIR:-/data}"

for used in "$PANEL_PORT" "${XRAY_API_PORT:-10085}"; do
  if [ "$NGINX_PORT" = "$used" ]; then
    echo "The public port ($NGINX_PORT) collides with an internal one."
    echo "Change PANEL_PORT or XRAY_API_PORT in Railway -> Variables."
    exit 1
  fi
done

if [ ! -w "$DATA_DIR" ]; then
  echo "$DATA_DIR is not writable. Attach a Railway volume mounted at $DATA_DIR,"
  echo "otherwise every redeploy wipes your inbounds and clients."
  exit 1
fi

echo "public=$NGINX_PORT  panel=$PANEL_PORT  data=$DATA_DIR"

# Bootstrap config so nginx can answer health checks before the panel is up.
sed -e "s/\${NGINX_PORT}/$NGINX_PORT/g" \
    -e "s/\${PANEL_PORT}/$PANEL_PORT/g" \
    /app/nginx.conf.tmpl > /etc/nginx/nginx.conf
mkdir -p /run/nginx
nginx -t
nginx

export NGINX_PORT
exec node /app/server/index.js
