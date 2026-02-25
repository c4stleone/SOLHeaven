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

RUN chmod +x scripts/docker_app_entrypoint.sh

EXPOSE 8787

CMD ["bash", "scripts/docker_app_entrypoint.sh"]
