FROM node:20-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json tsconfig.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci && npm ci --prefix frontend

COPY app ./app
COPY sdk ./sdk
COPY scripts ./scripts
COPY frontend ./frontend

RUN npm --prefix frontend run build

# Convert CRLF to LF for shell scripts (Windows/Mac compatibility)
RUN apt-get update && apt-get install -y dos2unix && rm -rf /var/lib/apt/lists/*
RUN dos2unix scripts/docker_app_entrypoint.sh && chmod +x scripts/docker_app_entrypoint.sh

EXPOSE 8787

CMD ["bash", "scripts/docker_app_entrypoint.sh"]
