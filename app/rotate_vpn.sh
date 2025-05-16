#!/bin/sh
set -e
# set -x

echo "--- VPN Rotation Supervisor ---"

# --- CONFIGURATION ---
AUTH_FILE_PATH="/etc/openvpn/auth.txt"
OVPN_CONFIG_DIR="/etc/openvpn/configs"
PRIVOXY_CONFIG="/app/config"
OPENVPN_LOG="/tmp/openvpn_connect.log"
ROTATION_INTERVAL_SECONDS=${ROTATION_INTERVAL:-300}

# --- GLOBAL VARIABLES for file list ---
# OVPN_FILE_LIST will hold newline-separated, shuffled file paths
OVPN_FILE_LIST=""
# CURRENT_OVPN_FILE will hold the path for the current iteration
CURRENT_OVPN_FILE=""

# --- ENSURE /dev/net/tun EXISTS ---
if [ ! -c /dev/net/tun ]; then
  echo "FATAL: /dev/net/tun device not found."
  exit 1
fi

# --- ENSURE AUTH FILE EXISTS ---
if [ ! -f "$AUTH_FILE_PATH" ]; then
  echo "FATAL: OpenVPN auth file $AUTH_FILE_PATH not found."
  exit 1
fi

# --- FUNCTION TO LOAD AND SHUFFLE OVPN FILES into OVPN_FILE_LIST ---
load_and_shuffle_ovpn_files() {
  echo "DEBUG (func): Entered load_and_shuffle_ovpn_files."
  _old_ifs="$IFS"
  IFS=$'\n'
  echo "DEBUG (func): IFS set to newline."

  echo "DEBUG (func): Finding files in $OVPN_CONFIG_DIR..."
  # OVPN_FILE_LIST is a global variable
  OVPN_FILE_LIST=$(find "$OVPN_CONFIG_DIR" -maxdepth 1 -type f -name "*.ovpn" -print 2>/tmp/find_stderr.txt | shuf)
  _find_stderr=$(cat /tmp/find_stderr.txt)
  if [ -n "$_find_stderr" ]; then
    echo "DEBUG (func): find stderr: [$_find_stderr]"
  fi

  echo "DEBUG (func): OVPN_FILE_LIST is now: --START--\n$OVPN_FILE_LIST\n--END--"
  _list_len=$(echo -n "$OVPN_FILE_LIST" | wc -c)
  echo "DEBUG (func): OVPN_FILE_LIST character count (wc -c): $_list_len"

  IFS="$_old_ifs"
  echo "DEBUG (func): Restored IFS to [$_old_ifs]."

  if [ -z "$OVPN_FILE_LIST" ]; then
    echo "No .ovpn configuration files found in $OVPN_CONFIG_DIR"
    echo "DEBUG (func): OVPN_FILE_LIST is empty. Returning 1 (failure)."
    return 1
  fi

  _num_files=$(echo "$OVPN_FILE_LIST" | wc -l | awk '{$1=$1};1') # Count lines, trim whitespace
  echo "Found $_num_files OVPN configuration files in OVPN_FILE_LIST. Ready to cycle."
  echo "DEBUG (func): Returning 0 (success)."
  return 0
}

# --- FUNCTION to get the next file from OVPN_FILE_LIST ---
# Modifies OVPN_FILE_LIST (removes the first line)
# Sets CURRENT_OVPN_FILE
# Returns 0 if a file was retrieved, 1 if the list was empty
get_next_ovpn_file() {
  if [ -z "$OVPN_FILE_LIST" ]; then
    CURRENT_OVPN_FILE=""
    return 1 # List is empty
  fi

  _old_ifs="$IFS"
  IFS=$'\n' # Ensure we process line by line

  # Get the first line (next file)
  # Use `read` to get the first line, and `tail -n +2` to get the rest.
  # This is a bit more robust than direct string manipulation for multiline strings in sh.
  # However, simple string manipulation might be easier if read proves tricky with BusyBox sh.
  # Let's try with `expr` and `sed` first for simplicity, common in BusyBox.

  # Get first line
  CURRENT_OVPN_FILE=$(echo "$OVPN_FILE_LIST" | head -n 1)

  # Get rest of the lines (everything except the first)
  # `sed '1d'` deletes the first line
  OVPN_FILE_LIST=$(echo "$OVPN_FILE_LIST" | sed '1d')

  IFS="$_old_ifs"

  if [ -z "$CURRENT_OVPN_FILE" ]; then # Should not happen if OVPN_FILE_LIST was not empty
      return 1
  fi
  return 0
}


# --- GLOBAL VARIABLE FOR PRIVPROXY PID ---
privoxy_pid=""

# --- FUNCTION TO CLEANUP PROCESSES ---
cleanup() {
  echo "Caught signal or exiting, cleaning up..."
  if [ -n "$privoxy_pid" ] && kill -0 "$privoxy_pid" 2>/dev/null; then
    echo "Stopping Privoxy (PID: $privoxy_pid)..."
    kill "$privoxy_pid"
    _wait_count=0
    while kill -0 "$privoxy_pid" 2>/dev/null && [ $_wait_count -lt 5 ]; do
        sleep 0.5
        _wait_count=$((_wait_count + 1))
    done
    if kill -0 "$privoxy_pid" 2>/dev/null; then
        echo "Privoxy (PID: $privoxy_pid) did not stop gracefully, forcing kill (SIGKILL)."
        kill -9 "$privoxy_pid"
    fi
  fi
  privoxy_pid=""

  if pgrep -x openvpn > /dev/null; then
    echo "Stopping OpenVPN..."
    pkill -TERM openvpn
    _wait_count=0
    while pgrep -x openvpn > /dev/null && [ $_wait_count -lt 10 ]; do
      sleep 0.5
      _wait_count=$((_wait_count + 1))
    done
    if pgrep -x openvpn > /dev/null; then
      echo "OpenVPN did not stop gracefully, forcing kill (SIGKILL)..."
      pkill -KILL openvpn
    fi
  fi
  echo "Cleanup complete."
}

trap cleanup INT TERM EXIT

# --- INITIAL LOAD OF OVPN FILES ---
echo "DEBUG (main): Before initial call to load_and_shuffle_ovpn_files."
if ! load_and_shuffle_ovpn_files; then
  echo "FATAL: Could not load any OVPN files on initial startup."
  exit 1
fi
echo "DEBUG (main): After initial call. OVPN_FILE_LIST contains:\n$OVPN_FILE_LIST"

# --- MAIN ROTATION LOOP ---
while true; do
  echo "DEBUG (main loop): Top of while."

  if ! get_next_ovpn_file; then # If OVPN_FILE_LIST is empty
    echo "DEBUG (main loop): OVPN_FILE_LIST is empty. Entering reshuffle block."
    echo "Reached end of OVPN file list or no files loaded. Reshuffling..."
    if ! load_and_shuffle_ovpn_files; then
      echo "ERROR: Failed to reload OVPN files. Waiting 60s and retrying..."
      sleep 60
      continue # Go to top of while loop to try get_next_ovpn_file again
    fi
    # After successful reload, try to get the next file again
    if ! get_next_ovpn_file; then
        echo "FATAL: No OVPN files available even after attempting reload. Exiting."
        exit 1
    fi
  fi

  # CURRENT_OVPN_FILE is now set by get_next_ovpn_file
  PVPN_OVPN_FILE_PATH="$CURRENT_OVPN_FILE"
  echo "DEBUG (main loop): Processing file: [$PVPN_OVPN_FILE_PATH]"

  # ... (Rest of OpenVPN start, Privoxy start, sleep, cleanup logic remains the same) ...
  # ... (Make sure to use PVPN_OVPN_FILE_PATH which is now $CURRENT_OVPN_FILE) ...
  echo ""
  echo "----------------------------------------------------"
  echo "$(date): Starting new cycle. Using OVPN config: $(basename "$PVPN_OVPN_FILE_PATH")"
  echo "Full config path: $PVPN_OVPN_FILE_PATH"
  echo "----------------------------------------------------"

  touch "$OPENVPN_LOG"; chmod 600 "$OPENVPN_LOG"
  echo "Launching OpenVPN client in background..."
  openvpn \
    --config "$PVPN_OVPN_FILE_PATH" \
    --auth-user-pass "$AUTH_FILE_PATH" \
    --auth-nocache \
    --pull-filter ignore "route-ipv6" \
    --pull-filter ignore "ifconfig-ipv6" \
    --redirect-gateway def1 bypass-dhcp \
    --log "$OPENVPN_LOG" \
    --script-security 2 \
    --up /etc/openvpn/update-resolv-conf \
    --down /etc/openvpn/update-resolv-conf \
    --daemon

  VPN_INTERFACE="tun0"
  TIMEOUT=45
  echo "Waiting up to $TIMEOUT seconds for VPN interface $VPN_INTERFACE to appear and get an IP..."
  counter=0
  vpn_ip_assigned=0
  while [ $counter -lt $TIMEOUT ]; do
    if ip link show "$VPN_INTERFACE" > /dev/null 2>&1 && ip addr show "$VPN_INTERFACE" | grep -q "inet "; then
      echo ""
      echo "VPN interface $VPN_INTERFACE is UP and has an IP address."
      ip addr show "$VPN_INTERFACE"
      vpn_ip_assigned=1
      break
    fi
    echo -n "."
    sleep 1
    counter=$((counter + 1))
  done

  if [ "$vpn_ip_assigned" -eq 0 ]; then
    echo ""
    echo "Error: Timed out waiting for VPN interface $VPN_INTERFACE to initialize properly (get an IP)."
    echo "--- Last 20 lines of OpenVPN Log ($OPENVPN_LOG) ---"
    tail -n 20 "$OPENVPN_LOG" || echo "Log file $OPENVPN_LOG not found or unreadable."
    echo "----------------------------------------------------"
    if pgrep -x openvpn > /dev/null; then
      echo "OpenVPN process IS running, but interface check failed. Killing OpenVPN..."
      pkill -KILL openvpn
    else
      echo "OpenVPN process is NOT running!"
    fi
    echo "Skipping Privoxy start for this failed VPN. Trying next VPN server after a short delay..."
    sleep 5
  else
    if ! pgrep -x openvpn > /dev/null; then
        echo "Error: OpenVPN process is not running after successful interface check (unexpected). Skipping Privoxy."
        sleep 5
    else
      echo "OpenVPN process is running and interface is up."
      echo "Current /etc/resolv.conf (expected to be set by update-resolv-conf via VPN):"
      cat /etc/resolv.conf || echo "/etc/resolv.conf not found or unreadable"

      if [ -n "$DNS_SERVERS_OVERRIDE" ]; then
          echo "DNS_SERVERS_OVERRIDE is set ('$DNS_SERVERS_OVERRIDE'). Overriding /etc/resolv.conf..."
          _tmp_resolv="/tmp/resolv.conf.new.$$"
          echo "# Overridden by DNS_SERVERS_OVERRIDE in proton-privoxy entrypoint" > "$_tmp_resolv"
          echo "$DNS_SERVERS_OVERRIDE" | tr ',' '\n' | while IFS= read -r server; do
              server_trimmed=$(echo "$server" | awk '{$1=$1};1')
              if [ -n "$server_trimmed" ]; then
                  echo "nameserver $server_trimmed" >> "$_tmp_resolv"
              fi
          done
          if grep -q "nameserver" "$_tmp_resolv"; then
            cat "$_tmp_resolv" > /etc/resolv.conf
            echo "Updated /etc/resolv.conf with DNS_SERVERS_OVERRIDE. New contents:"
            cat /etc/resolv.conf
          else
            echo "Warning: DNS_SERVERS_OVERRIDE ('$DNS_SERVERS_OVERRIDE') was set but resulted in no valid nameserver entries."
          fi
          rm -f "$_tmp_resolv"
      fi

      echo "Starting Privoxy..."
      PRIVPROXY_LOGDIR="/var/log/privoxy"
      mkdir -p "$PRIVPROXY_LOGDIR"
      chown privoxy:privoxy "$PRIVPROXY_LOGDIR" 2>/dev/null || chown root:root "$PRIVPROXY_LOGDIR"
      privoxy --no-daemon "$PRIVOXY_CONFIG" &
      privoxy_pid=$!
      echo "Privoxy started with PID: $privoxy_pid"
      echo "Attempting to get current external IP..."
      current_ip=$(wget -T 10 -qO- http://ipv4.icanhazip.com || wget -T 10 -qO- http://ifconfig.me/ip || echo "N/A")
      echo "Current external IP via VPN: $current_ip (Server: $(basename "$PVPN_OVPN_FILE_PATH"))"
      echo "Sleeping for $ROTATION_INTERVAL_SECONDS seconds..."
      sleep "$ROTATION_INTERVAL_SECONDS"
      echo "Rotation interval elapsed. Stopping Privoxy..."
      if [ -n "$privoxy_pid" ] && kill -0 "$privoxy_pid" 2>/dev/null; then
        kill "$privoxy_pid"
        wait "$privoxy_pid" 2>/dev/null || true
      else
        echo "Privoxy was not running or PID $privoxy_pid unknown/invalid."
      fi
      privoxy_pid=""
    fi
  fi

  if pgrep -x openvpn > /dev/null; then
    echo "Stopping OpenVPN process for this cycle..."
    pkill -TERM openvpn
    _wait_count=0
    while pgrep -x openvpn > /dev/null && [ $_wait_count -lt 5 ]; do
      sleep 0.5
      _wait_count=$((_wait_count + 1))
    done
    if pgrep -x openvpn > /dev/null; then
      echo "OpenVPN did not stop gracefully after SIGTERM, forcing SIGKILL..."
      pkill -KILL openvpn
    fi
    echo "OpenVPN stopped for this cycle."
  fi
  # No 'shift' needed as we are managing OVPN_FILE_LIST and CURRENT_OVPN_FILE
done

