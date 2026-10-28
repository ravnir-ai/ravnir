# Ravnir box: the Linux computer each bot gets when it runs in its own container.
# Same Ubuntu release as the hub, so user-level installs copied from the old
# box homes keep working. Built by server/box.js on first use, or by hand:
#   podman build -t ravnir-box:3 --build-arg PLAYWRIGHT_VERSION=1.64.1 box/
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.4
ARG PLAYWRIGHT_VERSION=1.64.1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DISPLAY=:1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg tini sudo locales tzdata \
      xvfb openbox xdotool x11-utils imagemagick \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      python3 python3-pip python3-venv pipx build-essential \
      git openssh-client jq ripgrep tmux socat nano less procps psmisc \
      iproute2 iputils-ping dnsutils unzip zip xz-utils file \
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
    node --version; npm --version

# The same Playwright as the server, so the browser speaks the DevTools
# protocol the server expects. Full Chromium only (the desktop is visible).
RUN set -eux; \
    npm install -g "playwright@${PLAYWRIGHT_VERSION}"; \
    apt-get update; \
    playwright install --with-deps --no-shell chromium; \
    rm -rf /var/lib/apt/lists/*; \
    chrome="$(find /opt/pw-browsers -type f -name chrome -path '*chrome-linux*' | head -1)"; \
    test -x "$chrome"; \
    ln -s "$chrome" /usr/local/bin/ravnir-chromium

# Live view ("Take control"): x11vnc shares the box desktop, and the server reaches
# it through `exec socat` on the box's own loopback, never a published port. Its own
# layer, so adding it does not re-download Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc \
    && rm -rf /var/lib/apt/lists/*

COPY profile.sh /etc/profile.d/ravnir.sh
COPY box-start.sh browser.sh term-bridge.py /opt/ravnir/
RUN chmod 755 /opt/ravnir/box-start.sh /opt/ravnir/browser.sh /opt/ravnir/term-bridge.py

WORKDIR /root
CMD ["/opt/ravnir/box-start.sh"]
