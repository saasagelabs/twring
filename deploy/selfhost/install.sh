#!/bin/sh
# Twring self-hosted server installer.
#
#   curl -fsSL https://twring.com/install.sh | sudo sh
#
# Every question has a setting, so `sh install.sh --yes` with these set asks nothing:
#   TWRING_SPEECH_KEY, TWRING_SPEECH_PROVIDER (deepgram|xai, default deepgram)
#   TWRING_EMAIL, TWRING_NEWS (yes|no, default no)
#   TWRING_DOMAIN (optional), TWRING_PUBLIC_URL (sandboxes), TWRING_LISTEN_PORT (sandboxes, 8080)
#   TWRING_TRUSTED_PROXIES (sandboxes, default false), TWRING_AUDIO (auto|own|twring, default auto)
#   TWRING_LINK_AGENTS (yes|no, default yes), TWRING_AGENT_USER (whose agents, default the sudo
#   user), TWRING_SHARE_AGENTS (yes|no, default no: share those agents with people you add),
#   TWRING_VERSION (default latest)
#
# `--local-kit` uses the templates and the twring command beside this script (a checkout or an
# unpacked kit) instead of downloading the published kit; the folder and every file in it must be
# root's and writable by nobody else.
#
# It never installs Docker, never pipes another remote script, verifies the image digest, keeps
# every secret out of the terminal and out of command lines, and never touches an existing
# install (it offers `twring update` instead).
#
# Everything runs inside main, called on the last line: a download cut short runs nothing, and
# no command started by the installer can read the rest of the script from stdin.

set -eu

ROOT="${TWRING_ROOT:-/opt/twring}"
BIN_DIR="${TWRING_BIN_DIR:-/usr/local/bin}"
RELAY_URL="${TWRING_RELAY_URL:-https://relay.twring.com}"
VERSIONS_URL="https://twring.com/selfhost/versions.json"
KIT_URL="https://twring.com/selfhost/kit.tar.gz"
REPO="ghcr.io/saasagelabs/twring"
VOLUME="twring_twring-data"
SERVER_KEY_FILE=/data/keys/server-key.pem
RELAY_KEY_FILE=/data/keys/relay-key
RECOVER="Fix that, then run: twring start, then twring pair --admin (and twring link for your agents)."
YES=no
LOCAL_KIT=no
WORK=""
# A registration made by this run that no finished install uses yet is deleted again on exit.
REGISTERED=no
INSTALLED=no

say() { printf '%s\n' "$*"; }
die() {
  printf 'Stopped: %s\n' "$*" >&2
  exit 1
}
cleanup() {
  docker rm -f twring-probe-echo >/dev/null 2>&1 || true
  if [ "$REGISTERED" = yes ] && [ "$INSTALLED" = no ]; then
    if offline unregister >/dev/null 2>&1; then
      say "The install did not finish, so Twring's ring service deleted this server's registration."
    else
      say "The install did not finish, and Twring's ring service could not be reached to delete this server's registration. Write to support@twring.com if you want it deleted."
    fi
  fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}
fetch() { curl --proto '=https' --tlsv1.2 -fsSL "$@"; }
# A terminal to ask on. In a subshell: dash exits the whole script, silently, when a redirect
# fails on a special builtin like `:`.
has_tty() { [ "$YES" != yes ] && ( : </dev/tty ) 2>/dev/null; }
# Stops for a setting that is missing and cannot be asked for (--yes, or no terminal).
not_set() {
  if [ "$YES" = yes ]; then die "$1 is not set. Set it, or run without --yes to be asked."; fi
  die "$1 is not set, and there is no terminal here to ask on. Set it in the environment, or run this in a terminal."
}

# ask VAR "question" [default]: the setting if set, else the default with --yes (none: stop),
# else a prompt on the terminal (the script itself may be arriving on stdin).
ask() {
  eval "current=\${$1:-}"
  if [ -n "$current" ]; then return 0; fi
  if ! has_tty; then
    if [ $# -ge 3 ]; then
      eval "$1=\$3"
      return 0
    fi
    not_set "$1"
  fi
  printf '%s ' "$2" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  if [ -z "$answer" ] && [ $# -ge 3 ]; then answer=$3; fi
  [ -n "$answer" ] || die "$1 is needed."
  eval "$1=\$answer"
}

# Like ask, without echoing what is typed.
ask_secret() {
  eval "current=\${$1:-}"
  if [ -n "$current" ]; then return 0; fi
  has_tty || not_set "$1"
  printf '%s ' "$2" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r answer </dev/tty || answer=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
  [ -n "$answer" ] || die "$1 is needed."
  eval "$1=\$answer"
}

# A value that goes into a template or a settings file: one token, nothing that could break out.
safe() {
  case $2 in
    '' | *[!A-Za-z0-9._:/@,-]*) die "$1 has characters that are not allowed: use letters, digits and . _ : / @ , -" ;;
  esac
}

# A public DNS name: letters, digits, dots and inner dashes, at least two labels.
valid_host() {
  case $1 in
    '' | *[!A-Za-z0-9.-]* | -* | *- | .* | *. | *..* | *.-* | *-.*) return 1 ;;
    *.*) [ ${#1} -le 253 ] ;;
    *) return 1 ;;
  esac
}

check_version() {
  case $1 in
    '' | *[!A-Za-z0-9.]*) die "TWRING_VERSION may only contain letters, digits and dots, like 1 or 1.2.0." ;;
  esac
}

check_email() {
  case $1 in
    *[!A-Za-z0-9._%+@-]* | @* | *@*@*) die "TWRING_EMAIL does not look like an email address." ;;
    *@*) valid_host "${1#*@}" || die "TWRING_EMAIL does not look like an email address." ;;
    *) die "TWRING_EMAIL does not look like an email address." ;;
  esac
}

check_domain() {
  valid_host "$1" || die "TWRING_DOMAIN must be a domain name like twring.example.com."
}

# https://host or https://host:443, nothing else (no path, user or other port).
check_public_url() {
  case $1 in
    https://*) ;;
    *) die "TWRING_PUBLIC_URL must start with https:// (like https://abc123.sandbox.example.dev)." ;;
  esac
  rest=${1#https://}
  host=${rest%:443}
  valid_host "$host" ||
    die "TWRING_PUBLIC_URL must be https:// and a host name only, with no path and port 443 or none."
  PUBLIC_URL="https://$host"
}

# The sha256 for KEY in versions.json (`"KEY": "sha256:<hex>"`), or nothing.
json_digest() {
  key=$(printf '%s' "$1" | sed 's/[.]/[.]/g')
  printf '%s' "$VERSIONS" | tr -d '\n' |
    sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\(sha256:[0-9a-f]\{64\}\)\".*/\1/p"
}

# Whether a folder is owned by root and not writable by its group or others.
root_only() {
  # Split on purpose: owner uid and mode become $1 and $2.
  # shellcheck disable=SC2046
  set -- $(stat -c '%u %a' "$1" 2>/dev/null) || return 1
  [ "${1:-}" = 0 ] || return 1
  case ${2:-} in
    *[!0-7]* | '') return 1 ;;
  esac
  [ $((0$2 & 022)) -eq 0 ]
}

file_sha256() { openssl dgst -sha256 -r "$1" | cut -c1-64; }

# Whether an IPv4 address is one the internet can reach (not loopback, private, CGNAT,
# link-local or "this network").
public_ipv4() {
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$old_ifs
  [ $# -eq 4 ] || return 1
  case $1 in 0 | 10 | 127) return 1 ;; esac
  [ "$1" = 169 ] && [ "$2" = 254 ] && return 1
  [ "$1" = 192 ] && [ "$2" = 168 ] && return 1
  [ "$1" = 172 ] && [ "$2" -ge 16 ] && [ "$2" -le 31 ] && return 1
  [ "$1" = 100 ] && [ "$2" -ge 64 ] && [ "$2" -le 127 ] && return 1
  return 0
}

dc() { docker compose --env-file "$ROOT/twring.env" -f "$ROOT/compose.yml" -p twring "$@"; }

# Runs a command of the image as the server's user with the data volume (keys live there).
in_volume() {
  docker run --rm -i --user 10001:10001 -v "$VOLUME:/data" --entrypoint sh "$IMAGE" -c "$1"
}

# The admin command's relay side, before the server runs (no secret on the command line).
offline() {
  docker run --rm --user 10001:10001 -v "$VOLUME:/data" \
    -e TWRING_RELAY_URL="$RELAY_URL" -e TWRING_SERVER_KEY_FILE="$SERVER_KEY_FILE" \
    -e TWRING_RELAY_KEY_FILE="$RELAY_KEY_FILE" "$IMAGE" node dist/admin-cli.js "$@" </dev/null
}

probe_ok() { printf '%s' "$1" | grep -q "\"$2\":{\"ok\":true"; }

wait_ready() {
  tries=$(($1 / 2))
  while [ "$tries" -gt 0 ]; do
    if dc exec -T twring node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1 </dev/null; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 2
  done
  return 1
}

# Who holds 80/443 on this machine: "<port> <program>" lines (ss, else netstat, else nothing).
port_users() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltnp 2>/dev/null
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null
  fi | awk '{
    for (i = 1; i <= NF; i++) if ($i ~ /:(80|443)$/) {
      port = $i; sub(/.*:/, "", port); prog = "another program"
      if (match($0, /\("[^"]+"/)) prog = substr($0, RSTART + 2, RLENGTH - 3)
      else if (match($0, /[0-9]+\/[^ ]+/)) { prog = substr($0, RSTART, RLENGTH); sub(/^[0-9]+\//, "", prog) }
      print port, prog; break
    }
  }'
}

# --- Network maths for picking a free internal /24 --------------------------------------------

ip_int() {
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$old_ifs
  echo $((($1 << 24) + ($2 << 16) + ($3 << 8) + $4))
}

# overlaps A/len B/len: whether the two IPv4 ranges share an address.
overlaps() {
  a=${1%/*} al=${1#*/} b=${2%/*} bl=${2#*/}
  [ "$al" = "$1" ] && al=32
  [ "$bl" = "$2" ] && bl=32
  as=$(ip_int "$a") bs=$(ip_int "$b")
  as=$((as - as % (1 << (32 - al)))) bs=$((bs - bs % (1 << (32 - bl))))
  ae=$((as + (1 << (32 - al)) - 1)) be=$((bs + (1 << (32 - bl)) - 1))
  [ "$as" -le "$be" ] && [ "$bs" -le "$ae" ]
}

pick_subnet() {
  used=$(
    ip -4 route 2>/dev/null | awk '{print $1}'
    for id in $(docker network ls -q 2>/dev/null); do
      docker network inspect --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$id" 2>/dev/null
    done
  )
  for candidate in 172.29.41 172.29.42 172.29.43 172.30.41 10.229.41 10.229.42 192.168.229; do
    clash=no
    for net in $used; do
      case $net in
        *:* | default) continue ;;
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
        *) continue ;;
      esac
      if overlaps "$candidate.0/24" "$net"; then
        clash=yes
        break
      fi
    done
    if [ "$clash" = no ]; then
      SUBNET_BASE=$candidate
      return 0
    fi
  done
  die "Could not find a free private network for Twring's containers."
}

render() {
  sed -e "s|{{TWRING_IMAGE}}|$IMAGE|g" -e "s|{{ADDRESS}}|${ADDRESS:-}|g" \
    -e "s|{{AUDIO}}|$AUDIO|g" -e "s|{{SUBNET}}|${SUBNET_BASE:-}.0/24|g" \
    -e "s|{{CADDY_IP}}|${SUBNET_BASE:-}.2|g" -e "s|{{SERVER_IP}}|${SUBNET_BASE:-}.3|g" \
    -e "s|{{LIVEKIT_IP}}|${SUBNET_BASE:-}.4|g" -e "s|{{PUBLIC_URL}}|${PUBLIC_URL:-}|g" \
    -e "s|{{LISTEN_PORT}}|${LISTEN_PORT:-}|g" -e "s|{{TRUSTED_PROXIES}}|${TRUSTED_PROXIES:-}|g" "$1"
}

firewall_help() {
  say ""
  say "Open these ports on this machine. With ufw:"
  for port in "$@"; do say "  ufw allow $port"; done
  say "Or with firewalld:"
  for port in "$@"; do say "  firewall-cmd --permanent --add-port=$port"; done
  say "  firewall-cmd --reload"
  say "If the server is at a cloud provider, open the same ports in its firewall or security group too."
}

# The 80/443 check from outside, once the server is up (Caddy answers only then).
# A fresh certificate can take a little while, so HTTPS gets 3 tries over about 30 seconds.
check_web_ports() {
  tries=3
  while :; do
    result=$(dc exec -T twring node dist/admin-cli.js probe --address "$ADDRESS" --checks http,https 2>/dev/null </dev/null) || result=""
    tries=$((tries - 1))
    if probe_ok "$result" https || [ "$tries" -le 0 ]; then break; fi
    sleep 15
  done
  # No answer at all: the check runs inside the server, which is not running (not a port problem).
  if [ -z "$result" ]; then
    say "The Twring server is not running, so ports 80 and 443 could not be checked."
    return 0
  fi
  closed=""
  probe_ok "$result" http || closed="80/tcp"
  probe_ok "$result" https || closed="$closed 443/tcp"
  # shellcheck disable=SC2086
  if [ -n "$closed" ]; then
    say ""
    say "Phones cannot reach this server on$(printf ' %s' $closed) yet."
    firewall_help $closed
  fi
}

main() {
  for arg in "$@"; do
    case $arg in
      --yes | -y) YES=yes ;;
      --local-kit) LOCAL_KIT=yes ;;
      --help | -h)
        say "Twring self-hosted server installer. Run: curl -fsSL https://twring.com/install.sh | sudo sh"
        say "Settings for --yes: TWRING_SPEECH_KEY, TWRING_SPEECH_PROVIDER, TWRING_EMAIL, TWRING_NEWS,"
        say "TWRING_DOMAIN, TWRING_PUBLIC_URL, TWRING_AUDIO, TWRING_LINK_AGENTS, TWRING_AGENT_USER,"
        say "TWRING_SHARE_AGENTS, TWRING_VERSION. --local-kit: use the kit beside this script."
        exit 0
        ;;
      *) die "Unknown option $arg. Try --help." ;;
    esac
  done

  # --- 1. This machine --------------------------------------------------------------------------

  [ "$(id -u)" = 0 ] || die "Run the installer as root, for example: curl -fsSL https://twring.com/install.sh | sudo sh"
  [ "$(uname -s)" = Linux ] || die "Twring's server runs on Linux."
  case $(uname -m) in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) die "Twring's server runs on x86_64 or arm64 machines, not $(uname -m)." ;;
  esac

  # --- 2a. Never touch an existing install ------------------------------------------------------

  if [ -f "$ROOT/twring.env" ]; then
    say "Twring is already installed here ($ROOT). Nothing was changed."
    say "To move to the newest version, run: twring update"
    exit 0
  fi

  # Every setting given up front is checked before anything is downloaded or created.
  TWRING_VERSION=${TWRING_VERSION:-latest}
  check_version "$TWRING_VERSION"
  TWRING_AUDIO=${TWRING_AUDIO:-auto}
  case $TWRING_AUDIO in auto | own | twring) ;; *) die "TWRING_AUDIO must be auto, own or twring." ;; esac
  if [ -n "${TWRING_EMAIL:-}" ]; then check_email "$TWRING_EMAIL"; fi
  if [ -n "${TWRING_DOMAIN:-}" ]; then check_domain "$TWRING_DOMAIN"; fi
  SETUP=own
  if [ -n "${TWRING_PUBLIC_URL:-}" ]; then
    SETUP=sandbox
    check_public_url "$TWRING_PUBLIC_URL"
    [ "$TWRING_AUDIO" != own ] || die "In a sandbox (TWRING_PUBLIC_URL), call audio is Twring's: set TWRING_AUDIO to auto or twring."
    LISTEN_PORT=${TWRING_LISTEN_PORT:-8080}
    case $LISTEN_PORT in '' | *[!0-9]*) die "TWRING_LISTEN_PORT must be a port number." ;; esac
    TRUSTED_PROXIES=${TWRING_TRUSTED_PROXIES:-false}
    safe TWRING_TRUSTED_PROXIES "$TRUSTED_PROXIES"
  fi

  command -v openssl >/dev/null 2>&1 || die "The installer needs openssl (for example: apt install openssl)."
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    say "Twring runs in Docker with Docker Compose, and this machine does not have them yet."
    say "Install Docker Engine first: https://docs.docker.com/engine/install/"
    say "Then run this installer again."
    exit 1
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it (systemctl start docker) and run this again."

  # Left from an earlier install (or one that stopped part-way): checked before any question.
  if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    die "A Twring data volume ($VOLUME) already exists. To bring it back, use twring restore. To start over, remove it with: docker volume rm $VOLUME (its server may still be registered with Twring's ring service: run twring uninstall first if the twring command is here, or write to support@twring.com)."
  fi

  if [ "$SETUP" != sandbox ]; then
    busy=$(port_users | head -n 1)
    if [ -n "$busy" ]; then
      die "Port ${busy%% *} is already in use by ${busy#* }. Twring needs ports 80 and 443 for HTTPS: stop ${busy#* } (for example: systemctl stop ${busy#* }), or install in a sandbox with TWRING_PUBLIC_URL, then run this again."
    fi
  fi

  trap cleanup EXIT
  trap 'exit 1' INT TERM
  WORK=$(mktemp -d)
  chmod 700 "$WORK"

  # --- 2. The image, pinned by digest -----------------------------------------------------------

  VERSIONS=$(fetch "$VERSIONS_URL") || die "Could not reach twring.com to look up versions. Check this machine's internet connection."
  DIGEST=$(json_digest "$TWRING_VERSION")
  [ -n "$DIGEST" ] || die "Version $TWRING_VERSION is not published. Leave TWRING_VERSION unset for the newest."
  IMAGE="$REPO@$DIGEST"

  # The templates and the twring command: the published kit, checked, unless --local-kit asks for
  # the kit beside this script, and then only from a folder (and files) only root can change.
  KIT=""
  if [ "$LOCAL_KIT" = yes ]; then
    case $0 in */install.sh | install.sh) ;; *) die "--local-kit needs install.sh run as a file, not piped." ;; esac
    dir=$(dirname "$0")
    root_only "$dir" || die "--local-kit: $dir is not root's alone (others can change it). Nothing was installed."
    for name in compose.own.yml compose.twring.yml Caddyfile.tmpl livekit.yaml.tmpl twring; do
      [ -f "$dir/$name" ] || die "--local-kit: $dir/$name is missing."
      root_only "$dir/$name" || die "--local-kit: $dir/$name is not root's alone (others can change it). Nothing was installed."
    done
    KIT=$dir
  fi
  if [ -z "$KIT" ]; then
    KIT_DIGEST=$(json_digest kit)
    [ -n "$KIT_DIGEST" ] || die "The published version list has no installer kit."
    fetch "$KIT_URL" -o "$WORK/kit.tar.gz" || die "Could not download the installer kit."
    [ "sha256:$(file_sha256 "$WORK/kit.tar.gz")" = "$KIT_DIGEST" ] ||
      die "The installer kit does not match its published checksum. Nothing was installed."
    mkdir "$WORK/kit"
    tar -xzf "$WORK/kit.tar.gz" -C "$WORK/kit"
    KIT="$WORK/kit"
  fi

  say "Downloading Twring $TWRING_VERSION ($DIGEST)..."
  docker pull "$IMAGE" >/dev/null || die "Could not download the Twring image."
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" | grep -qx "$IMAGE" ||
    die "The downloaded image does not match the published digest. Nothing was installed."

  # --- 3. Speech --------------------------------------------------------------------------------

  say ""
  say "Twring needs one speech account to hear and speak on calls (Deepgram or xAI)."
  ask TWRING_SPEECH_PROVIDER "Speech provider, deepgram or xai? [deepgram]" deepgram
  case $TWRING_SPEECH_PROVIDER in deepgram | xai) ;; *) die "TWRING_SPEECH_PROVIDER must be deepgram or xai." ;; esac
  ask_secret TWRING_SPEECH_KEY "Your $TWRING_SPEECH_PROVIDER key (hidden):"
  case $TWRING_SPEECH_KEY in
    *[!A-Za-z0-9._-]*) die "That speech key has characters a key never has. Paste it again." ;;
  esac
  export TWRING_SPEECH_KEY TWRING_SPEECH_PROVIDER
  status=0
  docker run --rm -e TWRING_SPEECH_KEY -e TWRING_SPEECH_PROVIDER "$IMAGE" node dist/check-speech-key.js >/dev/null 2>&1 </dev/null || status=$?
  # From here on only twring.env gets the key: no later command sees it in its environment.
  SPEECH_KEY=$TWRING_SPEECH_KEY
  unset TWRING_SPEECH_KEY
  case $status in
    0) say "The $TWRING_SPEECH_PROVIDER key works." ;;
    2) die "$TWRING_SPEECH_PROVIDER refused that key. Check it in your $TWRING_SPEECH_PROVIDER account and try again." ;;
    3) die "Could not reach $TWRING_SPEECH_PROVIDER to check the key. Try again in a minute." ;;
    *) die "The speech key could not be checked. Set TWRING_SPEECH_PROVIDER to deepgram or xai." ;;
  esac

  # --- 4. Email ---------------------------------------------------------------------------------

  say ""
  say "Your email is for ring service, security notices and, later, your plan. No marketing unless you say yes."
  ask TWRING_EMAIL "Email:"
  check_email "$TWRING_EMAIL"
  ask TWRING_NEWS "Product news by email too? yes or no [no]" no
  case $TWRING_NEWS in yes | y | Y) TWRING_NEWS=yes ;; *) TWRING_NEWS=no ;; esac

  if [ "$SETUP" != sandbox ] && [ -z "${TWRING_DOMAIN:-}" ] && has_tty; then
    ask TWRING_DOMAIN "Your domain name for this server (Enter for an automatic address):" none
    if [ "$TWRING_DOMAIN" = none ]; then TWRING_DOMAIN=""; else check_domain "$TWRING_DOMAIN"; fi
  fi

  # --- 5. Keys: the server key in the data volume, the rest in twring.env (root, 600) ----------

  server_key=$(openssl genpkey -algorithm ed25519 2>/dev/null) || server_key=""
  case $server_key in
    *"BEGIN PRIVATE KEY"*) ;;
    *) die "openssl could not make the server key (it needs Ed25519 support: OpenSSL 1.1.1 or newer)." ;;
  esac
  ADMIN_TOKEN=$(openssl rand -hex 32) || ADMIN_TOKEN=""
  CREDENTIALS_KEY=$(openssl rand -base64 32) || CREDENTIALS_KEY=""
  LIVEKIT_KEY="API$(openssl rand -hex 8)" || LIVEKIT_KEY=""
  LIVEKIT_SECRET=$(openssl rand -hex 32) || LIVEKIT_SECRET=""
  [ ${#ADMIN_TOKEN} -eq 64 ] && [ ${#CREDENTIALS_KEY} -eq 44 ] && [ ${#LIVEKIT_KEY} -eq 19 ] &&
    [ ${#LIVEKIT_SECRET} -eq 64 ] || die "openssl could not make random keys."

  docker volume create --label com.docker.compose.project=twring \
    --label com.docker.compose.volume=twring-data "$VOLUME" >/dev/null
  say "Created the data volume $VOLUME."
  printf '%s\n' "$server_key" |
    in_volume "umask 077 && mkdir -p /data/keys && cat > $SERVER_KEY_FILE.new && chmod 600 $SERVER_KEY_FILE.new && mv $SERVER_KEY_FILE.new $SERVER_KEY_FILE" ||
    die "The server key could not be saved in the data volume. Remove it with docker volume rm $VOLUME and run this again."
  unset server_key
  in_volume "test -s $SERVER_KEY_FILE" </dev/null ||
    die "The server key is missing from the data volume. Remove it with docker volume rm $VOLUME and run this again."
  say "Generated the server key (kept in the data volume)."

  # --- 7. Address -------------------------------------------------------------------------------

  if [ "$SETUP" = sandbox ]; then
    ADDRESS=""
    RELAY_ADDRESS=$PUBLIC_URL
  else
    if [ -n "${TWRING_DOMAIN:-}" ]; then
      ADDRESS=$TWRING_DOMAIN
    else
      IP=$(offline ip) || die "Could not reach Twring's ring service to learn this machine's public address. Set TWRING_DOMAIN, or try again."
      case $IP in
        *[!0-9.]* | '') die "This machine's public address ($IP) is not IPv4. Set TWRING_DOMAIN to a domain that points here." ;;
      esac
      public_ipv4 "$IP" ||
        die "Twring's ring service could not see this server's public address. Set TWRING_DOMAIN and try again."
      ADDRESS="$(printf '%s' "$IP" | tr . -).sslip.io"
    fi
    RELAY_ADDRESS=$ADDRESS
    PUBLIC_URL="https://$ADDRESS"
  fi

  # --- 6. Register with the ring service --------------------------------------------------------

  if ! answer=$(offline register --email "$TWRING_EMAIL" --news "$TWRING_NEWS" --address "$RELAY_ADDRESS" 2>&1); then
    die "Could not register with Twring's ring service: $answer. Run the installer again after: docker volume rm $VOLUME"
  fi
  REGISTERED=yes
  say "Registered with Twring's ring service (a confirmation email is on its way to $TWRING_EMAIL)."

  # --- 8. Call audio ----------------------------------------------------------------------------

  if [ "$SETUP" = sandbox ]; then
    AUDIO=twring
  else
    if [ "$TWRING_AUDIO" = auto ]; then
      say "Checking whether phones can reach this machine for call audio (7881/tcp and 7882/udp)..."
      docker run -d --rm --name twring-probe-echo -p 7881:7881/tcp -p 7882:7882/udp \
        -e TWRING_PROBE_ECHO_SECONDS=60 "$IMAGE" node dist/probe-echo.js >/dev/null 2>&1 </dev/null ||
        say "Could not listen on 7881/7882 (another program may be using them)."
      # The echo says when it listens; up to 5 seconds, then the check runs anyway.
      waited=0
      while [ "$waited" -lt 5 ]; do
        if docker logs twring-probe-echo 2>&1 </dev/null | grep -q listening; then break; fi
        waited=$((waited + 1))
        sleep 1
      done
      result=$(offline probe --address "$ADDRESS" --checks tcp7881,udp7882 2>/dev/null) || result=""
      docker rm -f twring-probe-echo >/dev/null 2>&1 || true
      closed=""
      probe_ok "$result" udp7882 || closed="7882/udp"
      probe_ok "$result" tcp7881 || closed="$closed 7881/tcp"
      if probe_ok "$result" udp7882 || probe_ok "$result" tcp7881; then
        AUDIO=own
        if ! probe_ok "$result" udp7882; then MEDIA=tcp; fi
        say "Call audio runs on this server."
      else
        AUDIO=twring
        say "Phones cannot reach this machine on 7881 or 7882, so calls use Twring's audio service."
      fi
      # shellcheck disable=SC2086
      if [ -n "$closed" ]; then firewall_help $closed; fi
    else
      AUDIO=$TWRING_AUDIO
    fi
    if [ "$AUDIO" = own ]; then SETUP=own; else SETUP=caddy; fi
    pick_subnet
  fi

  # --- 9. Files ---------------------------------------------------------------------------------

  mkdir -p "$ROOT"
  chmod 755 "$ROOT"
  umask 077
  {
    say "# Twring server settings. Secrets: root only (600), never share this file."
    say "TWRING_ADMIN_TOKEN=$ADMIN_TOKEN"
    say "CORD_CREDENTIALS_KEY=$CREDENTIALS_KEY"
    say "TWRING_SERVER_KEY_FILE=$SERVER_KEY_FILE"
    say "TWRING_RELAY_KEY_FILE=$RELAY_KEY_FILE"
    say "TWRING_RELAY_URL=$RELAY_URL"
    if [ "$TWRING_SPEECH_PROVIDER" = xai ]; then
      say "XAI_API_KEY=$SPEECH_KEY"
    else
      say "DEEPGRAM_API_KEY=$SPEECH_KEY"
    fi
    if [ "$AUDIO" = own ]; then
      say "LIVEKIT_API_KEY=$LIVEKIT_KEY"
      say "LIVEKIT_API_SECRET=$LIVEKIT_SECRET"
    fi
  } >"$ROOT/twring.env.new"
  chmod 600 "$ROOT/twring.env.new"
  mv "$ROOT/twring.env.new" "$ROOT/twring.env"
  unset ADMIN_TOKEN CREDENTIALS_KEY LIVEKIT_KEY LIVEKIT_SECRET SPEECH_KEY

  {
    say "# Written by the Twring installer. No secrets here."
    say "TWRING_IMAGE='$IMAGE'"
    say "TWRING_VERSION='$TWRING_VERSION'"
    say "TWRING_SETUP='$SETUP'"
    say "TWRING_AUDIO='$AUDIO'"
    say "TWRING_ADDRESS='$PUBLIC_URL'"
    say "TWRING_PROBE_ADDRESS='$RELAY_ADDRESS'"
    # From the install-time check: call media reaches this server over TCP only.
    if [ "${MEDIA:-}" = tcp ]; then say "TWRING_MEDIA='tcp'"; fi
  } >"$ROOT/install.conf"
  chmod 600 "$ROOT/install.conf"
  umask 022

  case $SETUP in
    sandbox) render "$KIT/compose.twring.yml" >"$ROOT/compose.yml" ;;
    own)
      render "$KIT/compose.own.yml" >"$ROOT/compose.yml"
      render "$KIT/Caddyfile.tmpl" >"$ROOT/Caddyfile"
      cp "$KIT/livekit.yaml.tmpl" "$ROOT/livekit.yaml"
      # LiveKit runs as 65532 and must read it; it holds nothing secret.
      chmod 644 "$ROOT/livekit.yaml"
      ;;
    caddy)
      sed '/^[[:space:]]*# own-audio:begin$/,/^[[:space:]]*# own-audio:end$/d' "$KIT/compose.own.yml" >"$WORK/compose.yml"
      render "$WORK/compose.yml" >"$ROOT/compose.yml"
      sed '/^[[:space:]]*# own-audio:begin$/,/^[[:space:]]*# own-audio:end$/d' "$KIT/Caddyfile.tmpl" >"$WORK/Caddyfile"
      render "$WORK/Caddyfile" >"$ROOT/Caddyfile"
      ;;
  esac
  chmod 644 "$ROOT/compose.yml"
  [ ! -f "$ROOT/Caddyfile" ] || chmod 644 "$ROOT/Caddyfile"
  say "Wrote $ROOT/compose.yml and $ROOT/twring.env (root only)."

  # --- 12. The twring command (before starting, so every later step and recovery can use it) --

  mkdir -p "$BIN_DIR"
  cp "$KIT/twring" "$BIN_DIR/twring.new"
  chmod 755 "$BIN_DIR/twring.new"
  mv "$BIN_DIR/twring.new" "$BIN_DIR/twring"
  say "Installed the twring command ($BIN_DIR/twring)."
  # From here the install exists (twring start, twring uninstall), so it keeps its registration.
  INSTALLED=yes

  # --- Start ------------------------------------------------------------------------------------

  say "Starting Twring..."
  if ! output=$(dc up -d 2>&1 </dev/null); then
    printf '%s\n' "$output" >&2
    die "Docker could not start Twring (the error is above). $RECOVER"
  fi
  if ! wait_ready 120; then
    say "Twring did not report ready within 120 seconds."
    if [ "$SETUP" != sandbox ]; then check_web_ports; fi
    die "See twring logs for details. $RECOVER"
  fi
  if [ "$SETUP" != sandbox ]; then check_web_ports; fi

  say ""
  say "Twring is running at $PUBLIC_URL"

  # --- 10 and 11. The first admin's phone, then the agents --------------------------------------

  flags=""
  if [ "$YES" = yes ]; then flags="--yes"; fi
  TWRING_ROOT=$ROOT "$BIN_DIR/twring" pair --admin </dev/null
  # shellcheck disable=SC2086
  case ${TWRING_LINK_AGENTS:-yes} in
    no | n | N) say "To link this machine's agents later, run: twring link" ;;
    *) TWRING_ROOT=$ROOT "$BIN_DIR/twring" link --wait --ask-share $flags </dev/null ;;
  esac
}

main "$@"
