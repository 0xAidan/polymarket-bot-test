# Use Node.js 20 LTS as base image (required for @polymarket/clob-client)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
# Using npm install instead of npm ci because package-lock.json may be out of sync
# TODO: Regenerate package-lock.json locally with 'npm install' and commit it
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies after build to reduce image size
RUN npm prune --production

# Expose port (default 3000, can be overridden via PORT env var)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
