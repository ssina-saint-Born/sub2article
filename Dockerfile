# Stage 1 — Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Leverage layer cache: reinstall only when lockfile changes
COPY package.json package-lock.json ./
RUN npm ci

# Copy rest of source (respects .dockerignore — node_modules/release/electron excluded)
COPY . .

# Vite inlines VITE_* at build time; declare as ARGs so Coolify build env is forwarded
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_DROPBOX_APP_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ENV VITE_DROPBOX_APP_KEY=$VITE_DROPBOX_APP_KEY

RUN npm run build

# Stage 2 — Runner
FROM nginx:alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
