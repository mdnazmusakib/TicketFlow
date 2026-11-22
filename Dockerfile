# syntax=docker/dockerfile:1.7
# TicketFlow single-host image: the API also serves the built web app (same origin,
# so the httpOnly SameSite session cookie works without third-party cookie rules).

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
# Same-origin API in production.
ENV VITE_API_BASE_URL=/api
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    FRONTEND_DIST_DIR=/app/frontend/dist \
    UPLOAD_DIR=/app/backend/uploads
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/db/migrations backend/db/migrations
COPY --from=build /app/frontend/dist frontend/dist
RUN mkdir -p backend/uploads && chown -R node:node backend/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/backend
CMD ["node", "dist/server.js"]
