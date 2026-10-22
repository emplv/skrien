#!/usr/bin/env bash
# Install a staged SKRIEN release on the server. Run as root:
#   sudo bash <staging dir>/deploy/install.sh <staging dir>
# deploy/deploy.sh stages the release and calls this for you.
set -euo pipefail

src="${1:?Usage: install.sh <staging dir>}"
home=/srv/skrien
app="$home/app"
port=4373

id skrien >/dev/null 2>&1 || useradd --system --create-home --home-dir "$home" --shell /usr/sbin/nologin skrien

install -d -o skrien -g skrien "$app"
rsync -a --delete --exclude node_modules --chown=skrien:skrien "$src"/ "$app"/
sudo -u skrien -H bash -c "cd '$app' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

if ! cmp -s "$app/deploy/skrien.service" /etc/systemd/system/skrien.service; then
  install -m 644 "$app/deploy/skrien.service" /etc/systemd/system/skrien.service
  systemctl daemon-reload
fi
systemctl enable skrien >/dev/null 2>&1
systemctl restart skrien

# Validate the full Caddy config before reloading; restore the previous snippet on failure.
snippet=/etc/caddy/conf.d/skrien.caddy
if ! cmp -s "$app/deploy/skrien.caddy" "$snippet"; then
  backup=""
  if [[ -f "$snippet" ]]; then backup="$(mktemp)"; cp "$snippet" "$backup"; fi
  install -m 644 "$app/deploy/skrien.caddy" "$snippet"
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    if [[ -n "$backup" ]]; then mv "$backup" "$snippet"; else rm -f "$snippet"; fi
    echo "Caddy rejected skrien.caddy; previous config kept." >&2
    exit 1
  fi
  [[ -n "$backup" ]] && rm -f "$backup"
  systemctl reload caddy
fi

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    echo "SKRIEN is up on 127.0.0.1:$port"
    exit 0
  fi
  sleep 0.5
done
echo "SKRIEN did not answer on port $port. Check: journalctl -u skrien -n 50" >&2
exit 1
