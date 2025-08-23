FROM --platform=linux/amd64 node:24

LABEL maintainer="Proton-Privoxy User"

EXPOSE 8100

# Default environment variables.
ENV PVPN_USERNAME="" \
    PVPN_PASSWORD="" \
    HOST_NETWORK= \
    DNS_SERVERS_OVERRIDE= \
    ROTATION_INTERVAL="300"

# RUN apt-get update \
#     && apt-get install -y wget gnupg \
#     && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
#     && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
#     && apt-get update \
#     && apt-get install -y google-chrome-stable

# Install packages
RUN apt update && apt install -y \
    coreutils \
    openvpn \
    openresolv \
    procps \
    curl \
    ca-certificates \
    libnss3 \
    libx11-xcb1 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libgtk-3-0 \
    fonts-liberation \
    xdg-utils \
    libgbm-dev \
    wget \
    bash \
    findutils `# Usually part of base, but good to be explicit for 'find'` \
    iproute2 \
    build-essential \
    python3 \
    && echo "Core packages installed (openvpn + tooling, removed nginx/privoxy)." \
    \
    && echo "Downloading ProtonVPN DNS update script (update-resolv-conf.sh)..." \
    && mkdir -p /etc/openvpn \
    && wget "https://raw.githubusercontent.com/ProtonVPN/scripts/master/update-resolv-conf.sh" -O "/etc/openvpn/update-resolv-conf" \
    && chmod +x "/etc/openvpn/update-resolv-conf" \
    && echo "update-resolv-conf.sh downloaded and made executable."

# RUN mkdir -p /run/dbus && chmod -R 777 /run/dbus && groupadd -r myuser && useradd -r -g myuser -s /bin/bash -G audio,video -m myuser


COPY ./tundialer-native /tundialer-native
COPY ./app/package.json ./app/package-lock.json /app/

WORKDIR /app

RUN npx patchright install chrome
RUN npm install

# Copy application source
COPY app /app

# Copy downloaded OpenVPN configuration files from host to image
COPY ovpn_configs /etc/openvpn/configs

# Make the scripts executable (legacy helper scripts if any)
RUN chmod +x /app/run || true \
    && chmod +x /app/*.sh || true
ENV DBUS_SESSION_BUS_ADDRESS=autolaunch:

# USER myuser

# Default command now runs the TypeScript-compiled supervisor if present, else fallback to legacy shell script
CMD ["/app/start.sh" ]

