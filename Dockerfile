FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7070 \
    POSTADMIN_DATA=/data \
    POSTADMIN_NO_UPDATE_CHECK=1

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7070

CMD ["node", "src/server.js", "--no-open"]
