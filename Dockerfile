FROM node:20-alpine

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

# Data dir is mounted as a volume — only copy seed if not already present
COPY data/services.json /tmp/services.json.default

RUN mkdir -p /app/data

# If no services.json in the mounted volume, copy the seed
CMD ["/bin/sh", "-c", \
  "[ ! -f /app/data/services.json ] && cp /tmp/services.json.default /app/data/services.json; node server.js"]

EXPOSE 55964
