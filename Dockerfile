# Lightweight self-hosted LAN baby monitor.
FROM node:22-alpine

WORKDIR /app

# Install only production deps (ws + selfsigned) against the lockfile.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js generate-cert.js ./
COPY public ./public

# Certs are generated on first boot into this volume so they persist.
VOLUME ["/app/certs"]

ENV PORT=8443
EXPOSE 8443

CMD ["node", "server.js"]
