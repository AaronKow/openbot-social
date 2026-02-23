FROM node:18-alpine

WORKDIR /app

# Copy build context (supports both repo-root and ./server contexts)
COPY . .

# Install dependencies from the directory that contains package.json
RUN if [ -f package.json ]; then \
      npm install --omit=dev; \
    elif [ -f server/package.json ]; then \
      cd server && npm install --omit=dev; \
    else \
      echo "Error: package.json not found in /app or /app/server"; \
      exit 1; \
    fi

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/status', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server from whichever layout is present in container
CMD ["sh", "-c", "if [ -f /app/index.js ]; then node /app/index.js; else node /app/server/index.js; fi"]
