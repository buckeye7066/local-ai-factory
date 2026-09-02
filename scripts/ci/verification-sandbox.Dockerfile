# syntax=docker/dockerfile:1
FROM node:20.19.5-bookworm-slim@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      bash \
      build-essential \
      ca-certificates \
      chromium \
      git \
      python3 \
      python3-pip \
      python3-pytest \
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
