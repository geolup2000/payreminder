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
      echo "$d"; return 0
    fi
  done
  return 1
}

APP_DIR="$(find_app "${1:-}")" || {
  err "Project not found. Run this script from the project directory
     or specify the project directory: ./install.sh /path/to/project"
  exit 1
}
info "Project found at: $APP_DIR"

# ------------------------------------------------------------
# 2. System details
# ------------------------------------------------------------
distro="$(. /etc/os-release && echo "${ID:-unknown}-${VERSION_ID:-unknown}")"
info "System: $distro"

# ------------------------------------------------------------
# 3. Install Node.js (>=18) if needed
# ------------------------------------------------------------
install_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(process.versions.node.split(".")[0] < 18 ? 1 : 0)' >/dev/null 2>&1; then
    info "Node.js is already installed: $(node --version)"
    return
  fi
  step "Installing Node.js LTS (NodeSource)..."
  apt-get update -y
  apt-get install -y curl ca-certificates
  if command -v node >/dev/null 2>&1; then
    warn "Old Node.js version: $(node --version). Replacing it with LTS."
  fi
  if [[ "$(command -v apt-get)" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || {
      err "NodeSource setup failed. Trying the default package (which may be older)."
      apt-get install -y nodejs
    }
  fi
  apt-get install -y nodejs || true
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js was not installed. Install it manually and run this script again."
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
step "Checking .env file..."
if [[ -f .env ]]; then
  warn ".env already exists; keeping it. Check that its values are correct:
     nano $APP_DIR/.env"
else
  if [[ -f .env.example ]]; then
    cp .env.example .env
    warn "Created .env from .env.example. COMPLETE IT before using the app:
     nano $APP_DIR/.env
     (at least ADMIN_USER, ADMIN_PASSWORD, SMTP_*, TELEGRAM_*, and APP_URL with your public URL)"
  else
    err "Neither .env nor .env.example exists. Stopping. Add a configuration file manually."
    exit 1
  fi
fi

# ------------------------------------------------------------
# 6. Configure APP_URL (prompt)
# ------------------------------------------------------------
if [[ ! -s .env ]] || ! grep -qE '^APP_URL=http' .env || grep -q '^APP_URL=http://localhost:3000$' .env; then
  echo
  read -r -p "Public application URL (e.g. https://reminder.example.com) [http://localhost:3000]: " PUBLIC_URL || true
  PUBLIC_URL="${PUBLIC_URL:-http://localhost:3000}"
  if grep -q '^APP_URL=' .env; then
    sed -i "s|^APP_URL=.*|APP_URL=${PUBLIC_URL}|" .env
  else
    echo "APP_URL=${PUBLIC_URL}" >> .env
  fi
  info "APP_URL set to: $PUBLIC_URL"
fi

# ------------------------------------------------------------
# 7. Set the initial application language
# ------------------------------------------------------------
step "Setting the initial application language..."
mkdir -p data
node <<'NODE'
const fs = require('fs');
const file = 'data/settings.json';
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}
if (!['en', 'ro'].includes(settings.language)) {
  settings.language = settings.emailLanguage === 'ro' ? 'ro' : 'en';
}
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
NODE
info "Application language is set to: $(node -p "require('./data/settings.json').language")"

# ------------------------------------------------------------
# 8. systemd service
# ------------------------------------------------------------
step "Creating the systemd service..."
NODE_BIN="$(command -v node)"
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
# 9. Summary
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
echo "  - Configure reminder schedules for each service in the admin panel."
echo "  - For internet access: set up a reverse proxy (Caddy/Nginx) and port forwarding in Proxmox."
echo "  - Follow logs in real time: journalctl -u payreminder -f"
echo
warn "Before using the app, open $APP_DIR/.env and enter your actual values
     (admin username and password, SMTP details, and Telegram settings), then restart the service.
     Run: nano $APP_DIR/.env && systemctl restart payreminder"
