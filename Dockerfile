FROM node:18-alpine

WORKDIR /app

# Copy server dependencies
COPY server/package*.json ./server/

# Install dependencies
RUN cd server && npm ci --production

# Copy server and client files
COPY server/ ./server/
COPY client-web/ ./client-web/

EXPOSE 3000

CMD ["node", "server/index.js"]
