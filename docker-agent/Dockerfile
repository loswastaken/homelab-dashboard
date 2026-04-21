FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
COPY index.js ./

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    DASHBOARD_URL=http://host.docker.internal:55964 \
    POLL_INTERVAL_MS=30000 \
    REPORT_API_KEY=

CMD ["node", "index.js"]
