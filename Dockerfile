FROM node:20-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY app ./app
COPY sdk ./sdk
COPY scripts ./scripts

RUN chmod +x scripts/docker_app_entrypoint.sh

EXPOSE 8787

CMD ["bash", "scripts/docker_app_entrypoint.sh"]
