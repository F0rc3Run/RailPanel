FROM node:22-alpine

ARG XRAY_VERSION=v25.6.8
ARG XRAY_ARCH=64

RUN apk add --no-cache nginx tini curl unzip ca-certificates tzdata

ENV TZ=Asia/Tehran
RUN ln -sf /usr/share/zoneinfo/${TZ} /etc/localtime && echo "${TZ}" > /etc/timezone

# Xray core. Pinned so a bad upstream release can never break a redeploy.
RUN curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${XRAY_ARCH}.zip" -o /tmp/xray.zip \
    && unzip -q /tmp/xray.zip -d /usr/local/xray \
    && rm /tmp/xray.zip \
    && chmod +x /usr/local/xray/xray \
    && /usr/local/xray/xray version

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY nginx.conf.tmpl start.sh ./
RUN chmod +x start.sh && mkdir -p /run/nginx /data

# Everything the panel owns lives here. Mount a Railway volume at /data.
ENV DATA_DIR=/data \
    XRAY_BIN=/usr/local/xray/xray \
    XRAY_ASSETS=/usr/local/xray \
    PANEL_HOST=127.0.0.1 \
    PANEL_PORT=8090 \
    XRAY_API_PORT=10085 \
    NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
