# syntax=docker/dockerfile:1
FROM node:20-slim
# better-sqlite3 偶发无 prebuilt 时需要本地编译：slim 缺 python/make/g++，提前备好（设计决策：不用 alpine/musl）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production TZ=Asia/Shanghai PORT=3423
VOLUME /app/data
EXPOSE 3423
# healthcheck 用免认证的 /api/health（node:20 自带 fetch）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3423)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# HOST 由 compose/.env 注入为内网 IP（设计 §9：host 网络下显式绑定，禁止 0.0.0.0 全网暴露）
CMD ["sh", "-c", "npx next start -H \"$HOST\" -p \"$PORT\""]
