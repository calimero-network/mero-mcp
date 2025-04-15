FROM node:20-slim

WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy bin directory first to ensure it exists for postinstall script
COPY bin ./bin
RUN chmod +x ./bin/mero-cli

COPY package*.json ./

# Remove the postinstall script that's causing issues
RUN sed -i 's/"postinstall": "chmod +x .\/bin\/mero-cli"//' package.json

RUN npm install

COPY . .

RUN npm run build

# Create and set permissions for data directory
RUN mkdir -p /app/data && \
    chmod 777 /app/data

EXPOSE 3000

CMD ["npm", "start"] 