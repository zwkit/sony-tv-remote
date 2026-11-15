# 电视遥控桥接服务（群晖 / 任意 Linux 通用镜像）
# 构建：docker build -t tv-remote .
FROM node:20-bookworm-slim

# android-tools-adb 提供 adb（遥控只需要 adb，没有音视频依赖）
# openssl 用来签实时预览需要的 HTTPS 自签证书（WebCodecs 只在安全上下文可用）
# Debian 源默认官方；国内 NAS 拉 deb.debian.org 常常很慢甚至超时，
# 构建时可换成镜像站（docker-compose.yml 里已经默认传了 mirrors.aliyun.com）
ARG DEBIAN_MIRROR=deb.debian.org
RUN if [ "$DEBIAN_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      android-tools-adb ca-certificates tzdata openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js ./
# server.js 里 require('./apkicon')，图标提取全靠它；漏了一个 copy 镜像就起不来
COPY apkicon.js ./
COPY public ./public
COPY vendor ./vendor
# 自绘「电视直播」图标；server.js 内嵌了同一份 base64 兜底，单独 build 镜像时也能跑
COPY assets ./assets

# HOME 指向数据卷：adb 的授权密钥存在 $HOME/.android，
# 持久化后电视只需授权一次，重建容器不用重新点“允许调试”。
ENV HOME=/app/data \
    TZ=Asia/Shanghai \
    PORT=8787 \
    HTTPS_PORT=8788 \
    DATA_DIR=/app/data

RUN mkdir -p /app/data
VOLUME ["/app/data"]
# 8787 = 遥控/应用列表（http）；8788 = 同一份服务（https，实时预览必须走这个）
EXPOSE 8787 8788

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
