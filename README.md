# Proton-Privoxy Docker

This project sets up a Privoxy HTTP proxy that routes all its traffic through a ProtonVPN OpenVPN connection. The OpenVPN server is automatically rotated at a configurable interval.

## Features

-   Privoxy HTTP Proxy
-   ProtonVPN integration using OpenVPN
-   Automatic rotation of ProtonVPN servers
-   Configurable rotation interval
-   DNS override capability
-   Dockerized for easy deployment

## Prerequisites

-   Docker
-   Docker Compose
-   A ProtonVPN account (Free or Paid)

## Setup

1.  **Clone the Repository (if applicable later):**
    ```bash
    git clone <repository_url>
    cd proton-privoxy-docker
    ```

2.  **OpenVPN Configurations:**
    -   Download your desired ProtonVPN OpenVPN configuration files (UDP recommended) from the [ProtonVPN Account Downloads page](https://account.protonvpn.com/downloads).
    -   Place the `.ovpn` files into the `ovpn_configs/` directory in this project.

3.  **Create `.env` File:**
    -   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    -   Edit the `.env` file and fill in your ProtonVPN credentials and other settings:
        ```env
        PVPN_USERNAME=YOUR_PROTONVPN_OPENVPN_USERNAME
        PVPN_PASSWORD=YOUR_PROTONVPN_OPENVPN_PASSWORD

        # Optional: Set the rotation interval in seconds (default is 300 seconds / 5 minutes)
        ROTATION_INTERVAL=300

        # Optional: Override DNS servers used by the container after VPN connection.
        # Comma-separated. Examples:
        # DNS_SERVERS_OVERRIDE=1.1.1.1,1.0.0.1 # Cloudflare
        # DNS_SERVERS_OVERRIDE=8.8.8.8,8.8.4.4 # Google
        # DNS_SERVERS_OVERRIDE=10.2.0.1       # Example ProtonVPN internal DNS
        DNS_SERVERS_OVERRIDE=
        ```
    **IMPORTANT:** The `PVPN_USERNAME` and `PVPN_PASSWORD` are your OpenVPN/IKEv2 credentials, **not** your main Proton account login. You can find these in your ProtonVPN account dashboard under Account -> OpenVPN / IKEv2 username.

4.  **Build and Run:**
    ```bash
    docker-compose build
    docker-compose up -d
    ```

## Usage

Once the container is running, configure your browser or application to use an HTTP proxy:

-   **Host/Address:** `localhost` (if running Docker locally) or the IP address of the machine running Docker.
-   **Port:** `8100` (or as configured in `docker-compose.yml` and Privoxy's `app/config`).

Check the logs to see the VPN server rotation:
```bash
docker-compose logs -f proton_privoxy_service