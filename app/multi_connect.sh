#!/bin/sh
set -e
# set -x

# Starts one OpenVPN + Privoxy pair per .ovpn config found.
# CHANGES (parallel mode):
#   * All ports are pre-assigned up front (respecting PRIVOXY_PORT_MAP & sequential gaps).
#   * nginx load balancer is generated & started FIRST (on BASE_PRIVOXY_PORT) before tunnels.
#   * All tunnel+privoxy startups are fired rapidly without per-tunnel sleep (still sequential function calls
#     because OpenVPN forks to daemon immediately; effectively "at once"). For true parallel heavy work we would
#     background start_single calls, but PID file writes would need locking not guaranteed in busybox shell.
# Base port defaults to 8100; each additional config increments by 1 unless PRIVOXY_PORT_MAP provides overrides.
# Strategy defaults to least_conn; override with LB_STRATEGY=round_robin.
# Optionally define:
#   BASE_PRIVOXY_PORT (default 8100)
#   MAX_CONNECTIONS   (limit number of configs started)
#   PRIVOXY_PORT_MAP  (comma-separated list like configA.ovpn=8111,configB.ovpn=8200)
#   DNS_SERVERS_OVERRIDE applied per tunnel after connection established.
# WARNING: All tunnels share network namespace; policy routing/isolation is NOT implemented.

echo "--- Multi Connection Supervisor ---"

AUTH_FILE_PATH="/etc/openvpn/auth.txt"
OVPN_CONFIG_DIR="/etc/openvpn/configs"
BASE_PORT="${BASE_PRIVOXY_PORT:-8100}"
LB_STRATEGY="${LB_STRATEGY:-least_conn}"
MAX_CONNECTIONS="${MAX_CONNECTIONS:-0}" # 0 means unlimited
PRIVOXY_PORT_MAP="${PRIVOXY_PORT_MAP:-}" # name=port,name2=port2
OPENVPN_BASE_LOG_DIR="/tmp/multi_ovpn_logs"
mkdir -p "$OPENVPN_BASE_LOG_DIR"

if [ ! -c /dev/net/tun ]; then
  echo "FATAL: /dev/net/tun missing" >&2; exit 1; fi
if [ ! -f "$AUTH_FILE_PATH" ]; then
  echo "FATAL: auth file missing" >&2; exit 1; fi

# Build associative map (emulated) of config->port using temporary files
PORT_FOR_CONFIG() {
  _cfg="$1"
  # First check explicit map
  echo "$PRIVOXY_PORT_MAP" | tr ',' '\n' | while IFS= read -r line; do
    key=${line%%=*}; val=${line#*=}
    if [ "$key" = "$2" ]; then
      echo "$val"; return
    fi
  done
  # Fallback: sequential assignment
  echo "" # empty means use sequential logic
}

# Gather configs (handle spaces). We also skip duplicate copies like "name (1).ovpn" if base exists.
RAW_CONFIGS=$(find "$OVPN_CONFIG_DIR" -maxdepth 1 -type f -name '*.ovpn' | sort)
if [ -z "$RAW_CONFIGS" ]; then
  echo "FATAL: No .ovpn configs found" >&2; exit 1; fi

count=0
echo "Load balancer: reserving frontend port $BASE_PORT for nginx."
next_port=$((BASE_PORT + 1))

# Track PIDs
PID_FILE="/tmp/multi_connect.pids"
: > "$PID_FILE"
PID_FRAG_DIR="/tmp/pids-fragments"
rm -rf "$PID_FRAG_DIR" 2>/dev/null || true
mkdir -p "$PID_FRAG_DIR"

# First pass: build mapping list (cfg_path|cfg_name|port) without launching anything (avoid subshell variable loss)
MAPPINGS_FILE="/tmp/multi_mappings.list"
: > "$MAPPINGS_FILE"
BACKEND_PORTS="" # for nginx upstream
IFS=$'\n'
for cfg in $RAW_CONFIGS; do
  [ -z "$cfg" ] && continue
  cfg_name_only=$(basename "$cfg")
  base_dedup=$(echo "$cfg_name_only" | sed 's/ (1)\.ovpn$/.ovpn/')
  if [ "$cfg_name_only" != "$base_dedup" ] && [ -f "$OVPN_CONFIG_DIR/$base_dedup" ]; then
    echo "Skipping duplicate copy: $cfg_name_only (original $base_dedup exists)"; continue
  fi
  count=$((count + 1))
  if [ "$MAX_CONNECTIONS" -gt 0 ] && [ $count -gt "$MAX_CONNECTIONS" ]; then
    echo "Reached MAX_CONNECTIONS=$MAX_CONNECTIONS mapping limit"; break
  fi
  mapped=$(echo "$PRIVOXY_PORT_MAP" | tr ',' '\n' | grep "^${cfg_name_only}=" | head -n1 | cut -d '=' -f2 || true)
  if [ -n "$mapped" ]; then
    port="$mapped"
  else
    port="$next_port"; next_port=$((next_port + 1))
  fi
  echo "$cfg|$cfg_name_only|$port" >> "$MAPPINGS_FILE"
  BACKEND_PORTS="$BACKEND_PORTS $port"
done
unset IFS

# Generate nginx config with all backend ports BEFORE starting tunnels
echo "Configuring nginx load balancer (pre-start) for Privoxy backends..."
if [ "$LB_STRATEGY" = "least_conn" ]; then STRATEGY_DIRECTIVE="least_conn;"; else STRATEGY_DIRECTIVE=""; fi
MODULE_CONF_DIR="/etc/nginx/modules"
PRELUDE="# module prelude"
if [ -d "$MODULE_CONF_DIR" ]; then
  PRELUDE="include $MODULE_CONF_DIR/*.conf;"
fi
cat > /etc/nginx/nginx.conf <<EOF
$PRELUDE
worker_processes  1;
events { worker_connections 1024; }
stream {
  upstream privoxy_backends {
    $STRATEGY_DIRECTIVE
EOF
# If no backends yet (edge case), insert a placeholder "down" server so nginx can start, will be reloaded later if needed.
if [ -z "$(echo $BACKEND_PORTS | awk '{$1=$1};1')" ]; then
  echo "    server 127.0.0.1:9 down; # placeholder to satisfy nginx upstream" >> /etc/nginx/nginx.conf
else
  for p in $BACKEND_PORTS; do
    [ "$p" = "$BASE_PORT" ] && continue
    echo "    server 127.0.0.1:$p;" >> /etc/nginx/nginx.conf
  done
fi
cat >> /etc/nginx/nginx.conf <<EOF
  }
  server {
    listen ${BASE_PORT};
    proxy_pass privoxy_backends;
  }
}
EOF
echo "Generated nginx.conf (starting nginx first):"; sed 's/^/  | /' /etc/nginx/nginx.conf
echo "Starting nginx load balancer (frontend port ${BASE_PORT}) BEFORE tunnels..."
nginx || { echo "FATAL: nginx failed to start" >&2; exit 1; }

# Launch function now simplified: expects cfg_path and pre-assigned port
start_single() {
  cfg_path="$1"; port="$2"; cfg_name=$(basename "$cfg_path")
  log_dir="$OPENVPN_BASE_LOG_DIR/$cfg_name"; mkdir -p "$log_dir"
  openvpn_log="$log_dir/openvpn.log"
  privoxy_runtime_config="/tmp/privoxy_${cfg_name}_${port}.conf"
  echo "Launching tunnel for $cfg_name on port $port"
  openvpn \
    --config "$cfg_path" \
    --auth-user-pass "$AUTH_FILE_PATH" \
    --auth-nocache \
    --pull-filter ignore "route-ipv6" \
    --pull-filter ignore "ifconfig-ipv6" \
    --redirect-gateway def1 bypass-dhcp \
    --log "$openvpn_log" \
    --script-security 2 \
    --up /etc/openvpn/update-resolv-conf \
    --down /etc/openvpn/update-resolv-conf \
    --daemon
  # short pause just to let interface/routes settle (reduced from 5s)
  sleep 2
  if [ -n "$DNS_SERVERS_OVERRIDE" ]; then
    tmp_resolv="/tmp/resolv.conf.override.$$"
    echo "# Overridden by DNS_SERVERS_OVERRIDE" > "$tmp_resolv"
    echo "$DNS_SERVERS_OVERRIDE" | tr ',' '\n' | while IFS= read -r s; do
      s_trim=$(echo "$s" | awk '{$1=$1};1'); [ -n "$s_trim" ] && echo "nameserver $s_trim" >> "$tmp_resolv"
    done
    if grep -q nameserver "$tmp_resolv"; then cat "$tmp_resolv" > /etc/resolv.conf; fi
    rm -f "$tmp_resolv"
  fi
  sed "s/listen-address  .*/listen-address  0.0.0.0:${port}/" /app/config > "$privoxy_runtime_config"
  privoxy --no-daemon "$privoxy_runtime_config" &
  priv_pid=$!
  # Write fragment (atomic per file) for later aggregation
  echo "$cfg_name:$priv_pid:$port" > "$PID_FRAG_DIR/$port.pidline"
}

# Second pass: launch all tunnels in PARALLEL
echo "Launching all tunnels in parallel..."
while IFS='|' read -r cfg_path cfg_name port; do
  [ -z "$cfg_path" ] && continue
  start_single "$cfg_path" "$port" &
done < "$MAPPINGS_FILE"

# Wait for all background start_single jobs to finish spawning privoxy
wait

# Aggregate fragment PID lines into single PID_FILE
: > "$PID_FILE"
for f in "$PID_FRAG_DIR"/*.pidline; do
  [ -f "$f" ] && cat "$f" >> "$PID_FILE"
done

echo "Started $(wc -l < "$PID_FILE" | awk '{$1=$1};1') Privoxy instances (parallel). PID/Port map:"; cat "$PID_FILE"
echo "All tunnels launched in parallel (nginx was started first). Press Ctrl+C to terminate (docker stop)." 

cleanup() {
  echo "Shutting down multi supervisor..."
  while IFS= read -r line; do
    name=$(echo "$line" | cut -d ':' -f1)
    pid=$(echo "$line" | cut -d ':' -f2)
    port=$(echo "$line" | cut -d ':' -f3)
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping Privoxy $name (PID $pid, port $port)"; kill "$pid" || true
    fi
  done < "$PID_FILE"
  pkill -TERM openvpn 2>/dev/null || true
  if pgrep nginx >/dev/null 2>&1; then
    echo "Stopping nginx load balancer"; pkill -TERM nginx || true; sleep 1; pkill -KILL nginx 2>/dev/null || true
  fi
  sleep 2
  pkill -KILL openvpn 2>/dev/null || true
}
trap cleanup INT TERM

# Simple wait loop
while true; do
  sleep 60
  # Optionally health-check each privoxy pid
  while IFS= read -r line; do
    pid=$(echo "$line" | cut -d ':' -f2)
    port=$(echo "$line" | cut -d ':' -f3)
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "WARNING: Privoxy on port $port appears down." >&2
    fi
  done < "$PID_FILE"
done
*** End Patch
