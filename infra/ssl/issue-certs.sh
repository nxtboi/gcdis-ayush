#!/bin/sh
# ==============================================================================
# GCDIS initial Let's Encrypt issuance (run once on the production HOST, from the
# repository root, after DNS A/AAAA records point at this server and the stack
# is up - the proxy serves /.well-known/acme-challenge/ from the certbot_www volume).
#
#   CERTBOT_EMAIL=ops@gcdis.in \
#   CERTBOT_DOMAINS="gcdis.in www.gcdis.in admin.gcdis.in api.gcdis.in" \
#   sh infra/ssl/issue-certs.sh
#
# Optional: CERTBOT_STAGING=1 (test against LE staging first, avoids rate limits)
#           CERT_NAME (default gcdis.in - must match nginx.conf ssl_certificate paths)
#           COMPOSE_FILE (default docker-compose.prod.yml)
# Renewal is automatic afterwards (`certbot` service); nginx reloads every 6h.
# ==============================================================================
set -eu

: "${CERTBOT_EMAIL:?CERTBOT_EMAIL is required (ACME account and expiry notices)}"
: "${CERTBOT_DOMAINS:?CERTBOT_DOMAINS is required (space-separated list)}"
CERT_NAME="${CERT_NAME:-gcdis.in}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

DC="docker compose -f $COMPOSE_FILE"

DOMAIN_ARGS=""
for d in $CERTBOT_DOMAINS; do
  DOMAIN_ARGS="$DOMAIN_ARGS -d $d"
done

STAGING_ARG=""
if [ "${CERTBOT_STAGING:-0}" = "1" ]; then
  STAGING_ARG="--staging"
fi

echo "[Issue Certs] Removing temporary self-signed bootstrap certificate (if present)..."
# Only delete the directory if it is the bootstrap cert, never a real certbot lineage.
$DC run --rm --no-deps --entrypoint sh certbot -c "
  set -e
  if [ -f /etc/letsencrypt/live/$CERT_NAME/.bootstrap-self-signed ]; then
    rm -rf /etc/letsencrypt/live/$CERT_NAME
    echo 'bootstrap certificate removed'
  fi
"

echo "[Issue Certs] Requesting certificate '$CERT_NAME' for: $CERTBOT_DOMAINS"
# shellcheck disable=SC2086
if ! $DC run --rm --no-deps --entrypoint certbot certbot certonly \
      --webroot -w /var/www/certbot \
      --cert-name "$CERT_NAME" \
      $DOMAIN_ARGS \
      --email "$CERTBOT_EMAIL" --agree-tos --no-eff-email \
      --non-interactive --keep-until-expiring $STAGING_ARG; then
  echo "[Issue Certs] certbot failed. Restoring a bootstrap certificate so nginx keeps running..."
  $DC run --rm --no-deps cert_init || true
  exit 1
fi

echo "[Issue Certs] Reloading nginx to pick up the new certificate..."
$DC exec proxy nginx -s reload

echo "[Issue Certs] Done."
