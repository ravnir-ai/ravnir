#!/usr/bin/env bash
# Ravnir installer. Builds the server image from this folder and runs it with rootless Podman
# (preferred) or Docker, keeps its data in the ravnir-data volume, turns sign-in on, and sets up
# how you reach it: Tailscale, your own domain (Caddy with automatic https), or this computer only.
# Rerun it any time to update; your data, password and choices are kept.
#
#   ./install.sh                      install or update (asks how to reach it)
#   ./install.sh --access tailscale   or: domain --domain ravnir.example.com, or: local
#   ./install.sh doctor               check the install
#   ./install.sh uninstall [--purge]  stop and remove it (--purge also deletes its data)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ravnir"
ENV_FILE="$CONFIG_DIR/ravnir.env"
STATE_FILE="$CONFIG_DIR/install.conf"
NAME="ravnir"
CADDY_NAME="ravnir-caddy"
VOLUME="ravnir-data"
CADDY_VOLUME="ravnir-caddy"
CADDY_IMAGE="docker.io/library/caddy:2.11.7"
LOCAL_IMAGE="localhost/ravnir:local"
QUADLET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"

COMMAND="install"
ACCESS=""
DOMAIN=""
RUNTIME=""
PORT=""
IMAGE=""
YES=0
RESET_PASSWORD=0
PURGE=0

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
interactive() { [ -t 0 ] && [ -t 1 ]; }

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --access tailscale|domain|local   how your phone and other computers reach Ravnir
  --domain NAME                     the domain for --access domain (its DNS must point here)
  --runtime podman|docker           force a container runtime
  --port N                          the port on this computer's loopback (default 3847)
  --image REF                       pull this image instead of building from this folder
  --reset-password                  make a new sign-in password
  --yes                             answer yes to every question (installing Podman, Tailscale, ...)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    install|doctor|uninstall) COMMAND="$1" ;;
    --access) ACCESS="${2:-}"; shift ;;
    --access=*) ACCESS="${1#*=}" ;;
    --domain) DOMAIN="${2:-}"; shift ;;
    --domain=*) DOMAIN="${1#*=}" ;;
    --runtime) RUNTIME="${2:-}"; shift ;;
    --runtime=*) RUNTIME="${1#*=}" ;;
    --port) PORT="${2:-}"; shift ;;
    --port=*) PORT="${1#*=}" ;;
    --image) IMAGE="${2:-}"; shift ;;
    --image=*) IMAGE="${1#*=}" ;;
    --reset-password) RESET_PASSWORD=1 ;;
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see ./install.sh --help)" ;;
  esac
  shift
done

confirm() {
  # confirm "question" -> 0 for yes. --yes answers yes; without a terminal the answer is no.
  [ "$YES" = 1 ] && return 0
  interactive || return 1
  local answer
  read -r -p "$1 [Y/n] " answer
  case "${answer:-y}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; elif have sudo; then sudo "$@"; else die "This step needs root and sudo is not installed: $*"; fi
}

# ---------- saved choices ----------

# Read, never sourced: a saved value is data, not shell.
state_get() { [ -f "$STATE_FILE" ] && grep -E "^$1=" "$STATE_FILE" | tail -1 | cut -d= -f2- || true; }

load_state() {
  RUNTIME="${RUNTIME:-$(state_get SAVED_RUNTIME)}"
  ACCESS="${ACCESS:-$(state_get SAVED_ACCESS)}"
  DOMAIN="${DOMAIN:-$(state_get SAVED_DOMAIN)}"
  PORT="${PORT:-$(state_get SAVED_PORT)}"
  PORT="${PORT:-3847}"
  IMAGE="${IMAGE:-$(state_get SAVED_IMAGE)}"
  check_values
}

# Everything here ends up in a unit file or a command line, so only plain values are accepted.
check_values() {
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be a number from 1 to 65535"
  case "$RUNTIME" in ""|podman|docker) ;; *) die "--runtime must be podman or docker" ;; esac
  case "$ACCESS" in ""|tailscale|domain|local) ;; *) die "--access must be tailscale, domain or local" ;; esac
  [ -z "$IMAGE" ] || [[ "$IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}$ ]] || die "--image must be an image reference like ghcr.io/owner/ravnir:1.0"
  [ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || die "Give a domain name, for example --domain ravnir.example.com"
}

save_state() {
  mkdir -p "$CONFIG_DIR"
  umask 077
  cat > "$STATE_FILE" <<EOF
SAVED_RUNTIME=$RUNTIME
SAVED_ACCESS=$ACCESS
SAVED_DOMAIN=$DOMAIN
SAVED_PORT=$PORT
SAVED_IMAGE=$IMAGE
EOF
}

env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

# head stops reading after 24 characters, so tr ends on SIGPIPE; with pipefail that is not a failure here.
new_password() { (LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 24) || true; }

host_timezone() {
  local tz=""
  if have timedatectl; then tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; fi
  [ -z "$tz" ] && [ -f /etc/timezone ] && tz="$(cat /etc/timezone)"
  printf '%s' "${tz:-UTC}"
}

# ---------- container runtime ----------

podman_ok() { have podman && podman info >/dev/null 2>&1; }
docker_ok() { have docker && docker info >/dev/null 2>&1; }

detect_runtime() {
  case "$RUNTIME" in
    podman) podman_ok || die "Podman is not working for this user. Run: podman info"; return ;;
    docker) docker_ok || die "Docker is not working for this user. Is the daemon running, and are you in the docker group?"; return ;;
    "") ;;
    *) die "--runtime must be podman or docker" ;;
  esac
  if podman_ok; then RUNTIME=podman; return; fi
  if docker_ok; then RUNTIME=docker; return; fi
  if have docker && ! docker_ok; then
    warn "Docker is installed but this user cannot use it (try: sudo usermod -aG docker $USER, then log in again)."
  fi
  if have apt-get && confirm "Neither Podman nor Docker works here. Install Podman (rootless) with apt?"; then
    as_root apt-get update -q
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q podman uidmap passt slirp4netns
    RUNTIME=podman
    return
  fi
  die "Install Podman (recommended) or Docker, then run this again."
}

rootless() { [ "$RUNTIME" = podman ] && [ "$(id -u)" != 0 ]; }

# Rootless Podman needs subordinate ids for this user; a range after every existing one is used.
ensure_subids() {
  rootless || return 0
  local user; user="$(id -un)"
  if grep -q "^$user:" /etc/subuid 2>/dev/null && grep -q "^$user:" /etc/subgid 2>/dev/null; then return 0; fi
  local start
  start="$(cat /etc/subuid /etc/subgid 2>/dev/null | awk -F: 'BEGIN{m=100000} {e=$2+$3; if (e>m) m=e} END{print m}')"
  say "Giving $user the user ids $start to $((start + 65535)) for rootless containers."
  as_root usermod --add-subuids "$start-$((start + 65535))" --add-subgids "$start-$((start + 65535))" "$user"
  podman system migrate >/dev/null 2>&1 || true
}

# With systemd for this user (and linger, so it starts at boot without a login), Podman runs Ravnir
# as a Quadlet unit; otherwise as a container with a restart policy.
use_quadlet() {
  rootless || return 1
  have systemctl && systemctl --user show-environment >/dev/null 2>&1 || return 1
  [ -x /usr/libexec/podman/quadlet ] || [ -e /usr/lib/systemd/user-generators/podman-user-generator ]
}

ensure_linger() {
  local user; user="$(id -un)"
  if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" = "yes" ]; then return 0; fi
  loginctl enable-linger "$user" 2>/dev/null || as_root loginctl enable-linger "$user" || warn "Could not turn on linger: Ravnir will start at boot only after you log in."
}

rt() { "$RUNTIME" "$@"; }

image_ref() { if [ -n "$IMAGE" ]; then printf '%s' "$IMAGE"; else printf '%s' "$LOCAL_IMAGE"; fi; }

build_image() {
  if [ -n "$IMAGE" ]; then
    step "Pulling $IMAGE"
    rt pull "$IMAGE"
    return
  fi
  step "Building the Ravnir image (the first build takes a few minutes)"
  if [ "$RUNTIME" = podman ]; then
    podman build --format docker -t "$LOCAL_IMAGE" "$REPO"
  else
    docker build -t "$LOCAL_IMAGE" "$REPO"
  fi
}

# ---------- sign-in and settings ----------

PASSWORD_SHOWN=""

write_env() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  local user password
  user="$(env_get RAVNIR_USER)"
  password="$(env_get RAVNIR_PASSWORD)"
  [ -z "$user" ] && user="$(id -un | tr -cd 'A-Za-z0-9._-')"
  [ -z "$user" ] && user="owner"
  if [ -z "$password" ] || [ "$RESET_PASSWORD" = 1 ]; then
    password="$(new_password)"
    PASSWORD_SHOWN="$password"
  fi
  local tz; tz="$(env_get TZ)"; [ -z "$tz" ] && tz="$(host_timezone)"
  local tmp="$ENV_FILE.tmp"
  umask 077
  {
    echo "# Ravnir settings, read by the container on every start. Kept when you rerun install.sh."
    echo "RAVNIR_USER=$user"
    echo "RAVNIR_PASSWORD=$password"
    echo "RAVNIR_ACCESS=$ACCESS"
    [ -n "$PUBLIC_URL" ] && echo "RAVNIR_PUBLIC_URL=$PUBLIC_URL"
    echo "TZ=$tz"
    # Anything else you added by hand is kept.
    if [ -f "$ENV_FILE" ]; then
      grep -vE '^(#|RAVNIR_USER=|RAVNIR_PASSWORD=|RAVNIR_ACCESS=|RAVNIR_PUBLIC_URL=|TZ=)' "$ENV_FILE" | grep -vE '^\s*$' || true
    fi
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  SIGNIN_USER="$user"
}

# ---------- how it is reached ----------

PUBLIC_URL=""

choose_access() {
  case "$ACCESS" in
    tailscale|domain|local) return ;;
    "") ;;
    *) die "--access must be tailscale, domain or local" ;;
  esac
  if ! interactive || [ "$YES" = 1 ]; then ACCESS="local"; return; fi
  say ""
  say "How will you reach Ravnir from your phone and other computers?"
  say "  1) Tailscale (recommended): private, https, nothing open to the internet"
  say "  2) My own domain: https with automatic certificates (ports 80 and 443 must be open)"
  say "  3) Only this computer for now (use an SSH tunnel from a laptop)"
  local answer
  read -r -p "Choose 1, 2 or 3 [1]: " answer
  case "${answer:-1}" in
    1) ACCESS=tailscale ;;
    2) ACCESS=domain ;;
    *) ACCESS=local ;;
  esac
}

tailscale_json() { tailscale status --json 2>/dev/null || true; }

setup_tailscale() {
  if ! have tailscale; then
    confirm "Tailscale is not installed. Install it now (runs the official script from tailscale.com)?" \
      || die "Install Tailscale (https://tailscale.com/download), then run this again, or use --access local."
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  local status_json; status_json="$(tailscale_json)"
  if ! [[ "$status_json" =~ \"BackendState\":\ *\"Running\" ]]; then
    step "Signing this server in to Tailscale (open the link it prints)"
    as_root tailscale up
  fi
  local dns
  # This machine's own entry only; sed -n 1p reads to the end, so nothing ends on SIGPIPE.
  dns="$( (tailscale status --json --peers=false 2>/dev/null || tailscale_json) | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | sed -n 1p)"
  dns="${dns%.}"
  [ -n "$dns" ] || die "Tailscale did not report this machine's name. Is MagicDNS on in the admin console?"
  # 443 unless something else already uses it on this machine's tailnet address.
  local https=443 status
  status="$(tailscale serve status --json 2>/dev/null || as_root tailscale serve status --json 2>/dev/null || echo '{}')"
  if [[ "$status" == *'"443"'* && "$status" != *"127.0.0.1:$PORT"* ]]; then https=8443; fi
  step "Serving Ravnir on your tailnet at https://$dns$([ "$https" = 443 ] || printf ':%s' "$https")"
  if ! tailscale serve --bg --https="$https" "http://127.0.0.1:$PORT" 2>/dev/null; then
    as_root tailscale serve --bg --https="$https" "http://127.0.0.1:$PORT" \
      || die "tailscale serve failed. Turn on HTTPS certificates in the Tailscale admin console (DNS page), then run this again."
  fi
  PUBLIC_URL="https://$dns$([ "$https" = 443 ] || printf ':%s' "$https")"
}

setup_domain_checks() {
  if [ -z "$DOMAIN" ] && interactive; then read -r -p "Domain for Ravnir (its DNS must point to this server): " DOMAIN; fi
  [ -n "$DOMAIN" ] && [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || die "Give a domain name, for example --domain ravnir.example.com"
  PUBLIC_URL="https://$DOMAIN"
  if rootless; then
    local start; start="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
    if [ "$start" -gt 80 ]; then
      confirm "Rootless Podman cannot use ports 80 and 443 yet. Allow unprivileged ports from 80 (a sysctl setting)?" \
        || die "Without ports 80 and 443 Caddy cannot get a certificate. Use --access tailscale or local."
      echo "net.ipv4.ip_unprivileged_port_start=80" | as_root tee /etc/sysctl.d/90-ravnir-ports.conf >/dev/null
      as_root sysctl -q -w net.ipv4.ip_unprivileged_port_start=80
    fi
  fi
}

# ---------- run ----------

remove_container() {
  local name="$1"
  if use_quadlet && [ -f "$QUADLET_DIR/$name.container" ]; then
    systemctl --user stop "$name.service" 2>/dev/null || true
  fi
  rt rm -f "$name" >/dev/null 2>&1 || true
}

write_quadlet() {
  mkdir -p "$QUADLET_DIR"
  cat > "$QUADLET_DIR/$NAME.container" <<EOF
# Written by Ravnir's install.sh. Rerun it instead of editing this file.
[Unit]
Description=Ravnir
Wants=network-online.target
After=network-online.target

[Container]
Image=$(image_ref)
ContainerName=$NAME
PublishPort=127.0.0.1:$PORT:3847
Volume=$VOLUME:/data
EnvironmentFile=$ENV_FILE
PodmanArgs=--shm-size=1g

[Service]
Restart=always
TimeoutStartSec=300

[Install]
WantedBy=default.target
EOF
  if [ "$ACCESS" = domain ]; then
    cat > "$QUADLET_DIR/$CADDY_NAME.container" <<EOF
# Written by Ravnir's install.sh: https for $DOMAIN in front of Ravnir.
[Unit]
Description=Ravnir https (Caddy)
After=$NAME.service

[Container]
Image=$CADDY_IMAGE
ContainerName=$CADDY_NAME
Network=host
Volume=$CADDY_VOLUME:/data
Exec=caddy reverse-proxy --from $DOMAIN --to 127.0.0.1:$PORT

[Service]
Restart=always

[Install]
WantedBy=default.target
EOF
  else
    rm -f "$QUADLET_DIR/$CADDY_NAME.container"
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$NAME.service"
  if [ "$ACCESS" = domain ]; then systemctl --user restart "$CADDY_NAME.service"; fi
}

run_plain() {
  local policy=unless-stopped
  [ "$RUNTIME" = podman ] && policy=always
  rt run -d --name "$NAME" --restart "$policy" \
    -p "127.0.0.1:$PORT:3847" --shm-size=1g \
    -v "$VOLUME:/data" --env-file "$ENV_FILE" \
    "$(image_ref)" >/dev/null
  if [ "$ACCESS" = domain ]; then
    rt run -d --name "$CADDY_NAME" --restart "$policy" --network host \
      -v "$CADDY_VOLUME:/data" "$CADDY_IMAGE" \
      caddy reverse-proxy --from "$DOMAIN" --to "127.0.0.1:$PORT" >/dev/null
  fi
}

port_in_use() {
  have ss || return 1
  [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]
}

wait_healthy() {
  local i
  for i in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/manifest.webmanifest" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# The web server answers first; OpenCode, which Ravnir starts itself, a few seconds later. The
# password goes to curl on stdin, not on its command line, which other users could see.
wait_opencode() {
  local user pass out i
  user="$(env_get RAVNIR_USER)"
  pass="$(env_get RAVNIR_PASSWORD)"
  for i in $(seq 1 90); do
    out="$(printf 'user = "%s:%s"\n' "$user" "$pass" | curl -fsS -K - "http://127.0.0.1:$PORT/api/setup" 2>/dev/null || true)"
    if [[ "$out" == *'"opencode":{"connected":true'* ]]; then return 0; fi
    sleep 1
  done
  warn "OpenCode is still starting. ./install.sh doctor shows when it is ready."
}

install() {
  load_state
  have curl || die "curl is needed. Install it (sudo apt install curl) and run this again."
  detect_runtime
  ensure_subids
  choose_access
  say "Container runtime: $RUNTIME$(rootless && printf ' (rootless)')"
  say "Access: $ACCESS"
  [ "$ACCESS" = domain ] && setup_domain_checks
  save_state

  build_image

  step "Starting Ravnir"
  remove_container "$CADDY_NAME"
  remove_container "$NAME"
  if port_in_use; then die "Port $PORT on this computer is in use. Rerun with --port N."; fi
  # The address goes into the settings before the start; Tailscale is set up once Ravnir answers.
  if [ "$ACCESS" = tailscale ]; then PUBLIC_URL="$(env_get RAVNIR_PUBLIC_URL)"; fi
  write_env
  if use_quadlet; then
    ensure_linger
    write_quadlet
  else
    run_plain
  fi
  wait_healthy || die "Ravnir did not answer on port $PORT. See: $RUNTIME logs $NAME"
  wait_opencode

  if [ "$ACCESS" = tailscale ]; then
    local before="$PUBLIC_URL"
    setup_tailscale
    if [ "$PUBLIC_URL" != "$before" ]; then
      write_env
      step "Restarting with the Tailscale address"
      if use_quadlet; then systemctl --user restart "$NAME.service"; else rt restart "$NAME" >/dev/null; fi
      wait_healthy || die "Ravnir did not come back. See: $RUNTIME logs $NAME"
    fi
  fi

  step "Ravnir is running"
  case "$ACCESS" in
    tailscale) say "Open $PUBLIC_URL on any device signed in to your tailnet." ;;
    domain) say "Open $PUBLIC_URL (the certificate can take a minute the first time)." ;;
    local)
      say "Open http://127.0.0.1:$PORT on this computer."
      say "From a laptop: ssh -L $PORT:127.0.0.1:$PORT $(id -un)@<this server>, then open http://127.0.0.1:$PORT"
      say "For your phone, rerun with --access tailscale." ;;
  esac
  if [ -n "$PASSWORD_SHOWN" ]; then
    say ""
    say "Sign in as:  $SIGNIN_USER"
    say "Password:    $PASSWORD_SHOWN"
    say "This is the only time the password is shown. It is saved in $ENV_FILE"
  else
    say "Sign in as $SIGNIN_USER with the password you were given (it is in $ENV_FILE)."
  fi
  say ""
  say "Check the install any time: ./install.sh doctor"
}

doctor() {
  load_state
  [ -n "$RUNTIME" ] || { podman_ok && RUNTIME=podman; } || { docker_ok && RUNTIME=docker; } || die "No container runtime works for this user."
  local failed=0
  printf '[%s] Container runtime: %s %s\n' "ok  " "$RUNTIME" "$(rt --version 2>/dev/null | awk 'NR==1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+/) { sub(/,$/, "", $i); print $i; exit } }')"
  if [ "$(rt inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; then
    printf '[%s] Container: running\n' "ok  "
  else
    printf '[%s] Container: not running (start it with ./install.sh)\n' "FAIL"
    exit 1
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3847}/manifest.webmanifest" 2>/dev/null; then
    printf '[%s] Port: answers on 127.0.0.1:%s\n' "ok  " "${PORT:-3847}"
  else
    printf '[%s] Port: nothing answers on 127.0.0.1:%s\n' "FAIL" "${PORT:-3847}"
    failed=1
  fi
  if use_quadlet && [ -f "$QUADLET_DIR/$NAME.container" ]; then
    printf '[%s] Starts at boot: Quadlet unit, linger %s\n' "ok  " "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
  else
    printf '[%s] Starts at boot: restart policy %s\n' "ok  " "$(rt inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NAME" 2>/dev/null || echo unknown)"
  fi
  rt exec "$NAME" node bin/doctor.mjs || failed=1
  exit "$failed"
}

uninstall() {
  load_state
  [ -n "$RUNTIME" ] || { podman_ok && RUNTIME=podman; } || { docker_ok && RUNTIME=docker; } || die "No container runtime works for this user."
  remove_container "$CADDY_NAME"
  remove_container "$NAME"
  if [ -f "$QUADLET_DIR/$NAME.container" ]; then
    rm -f "$QUADLET_DIR/$NAME.container" "$QUADLET_DIR/$CADDY_NAME.container"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  if [ "$PURGE" = 1 ]; then
    rt volume rm -f "$VOLUME" "$CADDY_VOLUME" >/dev/null 2>&1 || true
    rm -rf "$CONFIG_DIR"
    say "Removed Ravnir, its data and its settings."
  else
    say "Removed the Ravnir containers. Your data (volume $VOLUME) and settings ($CONFIG_DIR) are kept; --purge deletes them."
  fi
  if [ "$ACCESS" = tailscale ] && have tailscale; then say "Tailscale still serves the old address; stop it with: sudo tailscale serve reset"; fi
}

case "$COMMAND" in
  install) install ;;
  doctor) doctor ;;
  uninstall) uninstall ;;
esac
