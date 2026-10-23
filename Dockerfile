# 货记后端云容器镜像（CloudBase CloudRun，容器型 Node24）。
# 构建阶段：安装全部依赖以编译 TypeScript，再裁剪为生产依赖。
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# 运行阶段：只含运行依赖与编译产物；云数据后端不挂载本地数据卷。
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_BACKEND=cloudbase \
    ALLOW_DEV_LOGIN=false \
    TRUSTED_PROXY_HOPS=1
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# 只检查进程是否存活，不回显请求头、环境变量或依赖信息。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'.concat(process.env.PORT || '3000', '/livez')).then(function (r) { process.exit(r.ok ? 0 : 1); }).catch(function () { process.exit(1); })"
CMD ["node", "dist/server/index.js"]
