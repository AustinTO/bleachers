FROM node:22-bookworm

# Install FFmpeg and fonts
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install

# Copy source code
COPY index.ts ./

# Run via TSX
CMD ["npx", "tsx", "index.ts"]
