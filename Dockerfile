# Lightweight self-hosted LAN baby monitor.
FROM node:25-alpine

WORKDIR /app

# Install only production deps against the lockfile (reproducible).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js generate-cert.js ./
COPY public ./public

# Run as the unprivileged built-in "node" user; it owns only the certs dir it
# must write (TLS + VAPID keys are generated there on first boot).
RUN mkdir -p /app/certs && chown node:node /app/certs
USER node

# Certs persist in this volume across restarts.
VOLUME ["/app/certs"]

ENV PORT=8443
EXPOSE 8443

CMD ["node", "server.js"]
