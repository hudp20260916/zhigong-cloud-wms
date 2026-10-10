# 一体化部署镜像：Express 后端 + 构建好的前端一起跑。
# 后端检测到 web/dist 存在就会托管前端（见 server/src/app.ts），
# 所以只需要一个进程、一个域名，不用再单独部署静态站点。

# ---------- 构建阶段 ----------
FROM node:22-slim AS build
WORKDIR /app

# 先只拷依赖清单，利用 Docker 缓存
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist

# 数据目录：默认位置 + 供持久卷挂载的 /data
RUN mkdir -p /app/server/data /data

WORKDIR /app/server
EXPOSE 3001

# 健康检查用 /api/health（不需要鉴权）
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
