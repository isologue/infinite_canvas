FROM node:22-alpine AS web-build

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps --cache=/root/.npm --prefer-offline
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
ENV NEXT_TELEMETRY_DISABLED=1
# 给 .next/cache 挂 BuildKit 缓存，即使本层缓存失效重跑，next 也能复用上次的编译产物加速。
RUN --mount=type=cache,target=/app/web/.next/cache npm run build

FROM golang:1.25.10-alpine3.23 AS api-build

ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN go build -o /server .

FROM node:22-alpine

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV PROMPT_DATA_DIR=/app/data/prompts
RUN mkdir -p /app/data/prompts

EXPOSE 3000
CMD ["sh", "-c", "cd /app/web && PORT=3000 node server.js"]
