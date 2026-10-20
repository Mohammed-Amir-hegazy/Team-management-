FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN to use Turso; otherwise data goes to the /data volume.
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/team.db
EXPOSE 3000
CMD ["node", "server/index.js"]
