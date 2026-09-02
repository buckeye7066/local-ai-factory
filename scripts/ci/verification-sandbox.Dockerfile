# syntax=docker/dockerfile:1
FROM node:20.19.5-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      bash \
      build-essential \
      ca-certificates \
      git \
      python3 \
      python3-pip \
      python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.17.0 yarn@1.22.22 \
    && npm cache clean --force

ENV CI=true \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1

WORKDIR /workspace
ENTRYPOINT []
CMD ["node", "--version"]
