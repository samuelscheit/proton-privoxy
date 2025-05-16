FROM alpine:latest

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
        privoxy \
        procps \
        wget \
        bash \
        findutils `# Usually part of base, but good to be explicit for 'find'` \
    && echo "Core packages installed." \
    \
    && echo "Downloading ProtonVPN DNS update script (update-resolv-conf.sh)..." \
    && mkdir -p /etc/openvpn \
    && wget "https://raw.githubusercontent.com/ProtonVPN/scripts/master/update-resolv-conf.sh" -O "/etc/openvpn/update-resolv-conf" \
    && chmod +x "/etc/openvpn/update-resolv-conf" \
    && echo "update-resolv-conf.sh downloaded and made executable." \
    \
    && echo "Ensuring Privoxy base config directory exists..." \
    && mkdir -p /etc/privoxy \
    && echo "Privoxy config directory /etc/privoxy ensured."

# Copy application scripts and Privoxy main configuration
COPY app /app

# Copy downloaded OpenVPN configuration files from host to image
COPY ovpn_configs /etc/openvpn/configs

# Copy minimal/empty Privoxy standard config files
COPY empty.filter /etc/privoxy/default.filter
COPY default.action /etc/privoxy/default.action
COPY match-all.action /etc/privoxy/match-all.action

# Make the scripts executable
RUN chmod +x /app/run \
    && chmod +x /app/rotate_vpn.sh

# Default command to run when the container starts
CMD ["/app/run"]

