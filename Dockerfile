# Use Node.js 18 LTS as base image
FROM node:18-alpine

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

# Expose port (default 3000, can be overridden via PORT env var)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
