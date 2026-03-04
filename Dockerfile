# Use Node.js 20 LTS as base image (required for @polymarket/clob-client)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies after build to reduce image size
RUN npm prune --production

# Expose port (default 3001, can be overridden via PORT env var)
EXPOSE 3001

# Start the application (node runs built output; tsx is pruned in production)
CMD ["node", "dist/index.js"]
