FROM node:24-alpine

LABEL maintainer="Proton-Privoxy User"

EXPOSE 8100

# Default environment variables.
ENV PVPN_USERNAME="" \
    PVPN_PASSWORD="" \
    HOST_NETWORK= \
    DNS_SERVERS_OVERRIDE= \
    ROTATION_INTERVAL="300"

# Install packages
RUN apk --no-cache add \
    coreutils \
    openvpn \
    openresolv \
    procps \
    wget \
    bash \
    findutils `# Usually part of base, but good to be explicit for 'find'` \
    iproute2 \
    && echo "Core packages installed (openvpn + tooling, removed nginx/privoxy)." \
    \
    && echo "Downloading ProtonVPN DNS update script (update-resolv-conf.sh)..." \
    && mkdir -p /etc/openvpn \
    && wget "https://raw.githubusercontent.com/ProtonVPN/scripts/master/update-resolv-conf.sh" -O "/etc/openvpn/update-resolv-conf" \
    && chmod +x "/etc/openvpn/update-resolv-conf" \
    && echo "update-resolv-conf.sh downloaded and made executable."

# Copy application source
COPY app /app

# Copy downloaded OpenVPN configuration files from host to image
COPY ovpn_configs /etc/openvpn/configs

# Make the scripts executable (legacy helper scripts if any)
RUN chmod +x /app/run || true \
    && chmod +x /app/*.sh || true

# Install TS dependencies and build
WORKDIR /app
RUN if [ -f package.json ]; then npm install || true; fi

# Default command now runs the TypeScript-compiled supervisor if present, else fallback to legacy shell script
CMD ["sh", "-c", "node /app/index.ts" ]

