# Ravnir server image: the app, Playwright Chromium, a desktop for the agents' browsers
# (Xvfb, openbox, xdotool, x11vnc), OCR, and OpenCode, which Ravnir runs itself.
# install.sh builds and runs it; by hand:
#   docker build -t ravnir:local .
#   docker run -d --name ravnir -p 127.0.0.1:3847:3847 --shm-size=1g -v ravnir-data:/data \
#     -e RAVNIR_USER=you -e RAVNIR_PASSWORD=long-random-password ravnir:local
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.4
ARG OPENCODE_VERSION=1.18.35

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini tzdata locales xz-utils \
      git openssh-client python3 procps jq ripgrep unzip \
      xvfb xauth openbox xdotool x11vnc x11-utils ffmpeg \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa tesseract-ocr-por \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Node from the official tarball, checked against the published checksums.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch"; exit 1 ;; esac; \
    tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${tarball}\$" | sha256sum -c -; \
    tar -xJf "${tarball}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "${tarball}"; \
    node --version

# The image's own user (uid 1000) runs everything; the base image's "ubuntu" user had that uid.
RUN userdel -r ubuntu 2>/dev/null || true; \
    useradd --create-home --uid 1000 --shell /bin/bash ravnir; \
    mkdir -p /data /app && chown ravnir:ravnir /data /app

WORKDIR /app
COPY package.json package-lock.json ./
# Full Chromium only: Ravnir launches it by path, headless or on the desktop, so Playwright's
# separate headless shell (about 280 MB) is never used.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && chmod -R a+rX /opt/pw-browsers

RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" && rm -rf /root/.npm && opencode --version

COPY --chown=ravnir:ravnir . .

# In the container: listen for the published port (sign-in is required for that), keep the notes
# vault and OpenCode under /data, skip ai-memory, and let Chromium run without its own sandbox
# (the container is the boundary).
ENV RAVNIR_HOME=/data \
    RAVNIR_HOST=0.0.0.0 \
    RAVNIR_PORT=3847 \
    RAVNIR_VAULT=local \
    RAVNIR_OPENCODE=managed \
    RAVNIR_AI_MEMORY=off \
    RAVNIR_CHROMIUM_NO_SANDBOX=1 \
    RAVNIR_CONTAINER=1

USER ravnir
VOLUME /data
EXPOSE 3847
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:3847/manifest.webmanifest || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
