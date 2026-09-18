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
RUN echo 'server {' > /etc/nginx/conf.d/default.conf && \
    echo '    listen 80;' >> /etc/nginx/conf.d/default.conf && \
    echo '    server_name _;' >> /etc/nginx/conf.d/default.conf && \
    echo '    root /usr/share/nginx/html;' >> /etc/nginx/conf.d/default.conf && \
    echo '    index index.html;' >> /etc/nginx/conf.d/default.conf && \
    echo '    location / {' >> /etc/nginx/conf.d/default.conf && \
    echo '        try_files $uri $uri/ /index.html;' >> /etc/nginx/conf.d/default.conf && \
    echo '    }' >> /etc/nginx/conf.d/default.conf && \
    echo '    location /assets/ {' >> /etc/nginx/conf.d/default.conf && \
    echo '        expires 1y;' >> /etc/nginx/conf.d/default.conf && \
    echo '        add_header Cache-Control "public, immutable";' >> /etc/nginx/conf.d/default.conf && \
    echo '        access_log off;' >> /etc/nginx/conf.d/default.conf && \
    echo '    }' >> /etc/nginx/conf.d/default.conf && \
    echo '    gzip on;' >> /etc/nginx/conf.d/default.conf && \
    echo '    gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;' >> /etc/nginx/conf.d/default.conf && \
    echo '}' >> /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
