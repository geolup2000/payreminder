#!/usr/bin/env bash
# ============================================================
# PayReminder - automatic installation on an LXC container (Debian/Ubuntu)
#
# Run this script INSIDE an LXC container (NOT on the Proxmox host).
#
#   chmod +x install.sh
#   ./install.sh [/path/to/project]
#
# If no path is provided, the script looks for the project in:
#   the current directory and /opt/payreminder
# ============================================================
set -euo pipefail

C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_INDIGO='\033[0;35m'; C_BOLD='\033[1m'; C_NC='\033[0m'
info()  { echo -e "${C_GREEN}[install]${C_NC} $*"; }
warn()  { echo -e "${C_YELLOW}[install]${C_NC} $*"; }
err()   { echo -e "${C_INDIGO}[install]${C_NC} $*"; }
step()  { echo; echo -e "${C_BOLD}==> $*${C_NC}"; }

if [[ $EUID -ne 0 ]]; then
  err "Run this script as root (sudo ./install.sh)."
  exit 1
fi

# ------------------------------------------------------------
# 1. Locate the project directory
# ------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_app() {
  local d
  for d in "$1" "$SCRIPT_DIR" /opt/payreminder; do
    if [[ -n "$d" && -f "$d/package.json" ]]; then
      (cd -- "$d" && pwd -P); return $?
    fi
  done
  return 1
}

validate_service_path() {
  if [[ ! "$1" =~ ^/[a-zA-Z0-9._/-]+$ ]]; then
    err "Unsupported service path: use an absolute path containing only letters, digits, /, ., _, and -."
    return 1
  fi
}

APP_DIR="$(find_app "${1:-}")" || {
  err "Project not found. Run this script from the project directory
     or specify the project directory: ./install.sh /path/to/project"
  exit 1
}
validate_service_path "$APP_DIR"
info "Project found at: $APP_DIR"

# ------------------------------------------------------------
# 2. System details
# ------------------------------------------------------------
distro="$(. /etc/os-release && echo "${ID:-unknown}-${VERSION_ID:-unknown}")"
info "System: $distro"

# ------------------------------------------------------------
# 3. Install Node.js (>=20; Node 22 recommended) if needed
# ------------------------------------------------------------
node_supported() {
  local version
  command -v node >/dev/null 2>&1 || return 1
  version="$(node --version)" || return 1
  [[ "$version" =~ ^v([0-9]+)\. ]] && (( 10#${BASH_REMATCH[1]} >= 20 ))
}

install_node() {
  if node_supported; then
    info "Node.js is already installed: $(node --version)"
    return
  fi
  step "Installing Node.js 22 (NodeSource)..."
  apt-get update -y
  apt-get install -y curl ca-certificates
  if ! curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; then
    warn "NodeSource setup failed. Trying the distribution package; Node.js >=20 is required."
  fi
  apt-get install -y nodejs
  hash -r
  if ! node_supported; then
    err "Node.js >=20 is required (Node 22 recommended). Installed/fallback version is unsupported; install a supported version manually and rerun."
    exit 1
  fi
  info "Node.js installed: $(node --version)"
}

install_node

# ------------------------------------------------------------
# 4. npm dependencies
# ------------------------------------------------------------
step "Installing npm dependencies..."
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
info "Dependencies installed."

# ------------------------------------------------------------
# 5. .env file
# ------------------------------------------------------------
initialize_env() {
  if [[ -e .env || -L .env ]]; then
    warn "Existing .env preserved without changes."
    return
  fi
  if [[ ! -f .env.example ]]; then
    err "Neither .env nor .env.example exists. Add a configuration file manually."
    return 1
  fi
  (
    umask 077
    node <<'NODE'
  const fs = require('node:fs');
  const { randomBytes } = require('node:crypto');
  const template = fs.readFileSync('.env.example', 'utf8');
  const contents = template
    .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`)
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(32).toString('hex')}`);
  fs.writeFileSync('.env', contents, { mode: 0o600, flag: 'wx' });
NODE
  )
  info "Created private .env (mode 600) with random admin password and session secret. Inspect $APP_DIR/.env locally to retrieve your password; credentials are not printed."
}

step "Checking .env file..."
NEW_INSTALL=false
[[ -e .env || -L .env ]] || NEW_INSTALL=true
initialize_env

validate_env() {
  node <<'NODE'
  try {
    const fs = require('node:fs');
    const dotenv = require('dotenv');
    const values = dotenv.parse(fs.readFileSync('.env'));
    // The service reads .env, not the invoking shell's credential overrides.
    for (const key of ['ADMIN_USER', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'APP_URL']) delete process.env[key];
    Object.assign(process.env, values);
    require('./src/config').validateRuntimeConfig();
  } catch (error) {
    console.error('[install] Configuration validation failed: ' + error.message);
    console.error('[install] Existing files are unchanged. Edit .env locally before starting the service.');
    process.exit(1);
  }
NODE
}

step "Validating runtime configuration before service setup..."
validate_env

# ------------------------------------------------------------
# 6. Initial language (new installations only)
# ------------------------------------------------------------
initialize_language() {
  if [[ -e data/settings.json || -L data/settings.json ]]; then
    info "Existing application settings preserved without changes."
    return
  fi
  mkdir -p data
  (
    umask 077
    node <<'NODE'
  const fs = require('node:fs');
  fs.writeFileSync('data/settings.json', JSON.stringify({ language: 'en' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
NODE
  )
  info "Initial application language set to English."
}

if [[ "$NEW_INSTALL" == true ]]; then
  initialize_language
fi

# ------------------------------------------------------------
# 7. systemd service
# ------------------------------------------------------------
step "Creating the systemd service..."
NODE_BIN="$(command -v node)"
validate_service_path "$NODE_BIN"
SERVICE=/etc/systemd/system/payreminder.service

# Remove the old service name if it is still installed.
if [[ -f /etc/systemd/system/premiumreminder.service ]]; then
  systemctl disable --now premiumreminder || true
  rm -f /etc/systemd/system/premiumreminder.service
fi

cat > "$SERVICE" <<EOF
[Unit]
Description=PayReminder - recurring payment reminders
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN src/server.js
TimeoutStopSec=infinity
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

if [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
  systemctl enable --now payreminder
  systemctl restart payreminder || true
else
  warn "systemd is not active in this container; the service was not started automatically.
     Start it manually with: cd $APP_DIR && node src/server.js"
fi

# ------------------------------------------------------------
# 8. Summary
# ------------------------------------------------------------
step "Done! Installation summary:"
echo "  Application  : $APP_DIR"
echo "  Node.js      : $(node --version)"
echo
if systemctl is-active --quiet payreminder 2>/dev/null; then
  echo "  Status       : RUNNING (systemctl status payreminder)"
elif command -v systemctl >/dev/null 2>&1 && ! systemctl is-active payreminder >/dev/null 2>&1; then
  warn "  Status       : service is NOT active - check: systemctl status payreminder"
  warn "                 logs: journalctl -u payreminder -f"
fi
echo
echo "  Admin panel  : APP_URL/admin (see APP_URL in .env)"
echo "  Config file  : $APP_DIR/.env"
echo
echo "Notes:"
echo "  - After changing .env: systemctl restart payreminder"
echo "  - Configure Telegram and Discord notifications in Admin > Settings."
echo "  - Configure reminder schedules for each service in the admin panel."
echo "  - For internet access: set up a reverse proxy (Caddy/Nginx) and port forwarding in Proxmox."
echo "  - Follow logs in real time: journalctl -u payreminder -f"
echo
warn "Inspect $APP_DIR/.env locally to retrieve/store your admin password securely.
     Configure APP_URL and SMTP as needed, then restart the service.
     Keep the application port firewalled until HTTPS and setup are complete."
