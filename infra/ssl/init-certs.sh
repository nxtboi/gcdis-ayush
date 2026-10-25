#!/bin/sh
# ==============================================================================
# GCDIS TLS bootstrap (one-shot, runs before the nginx proxy starts)
# Creates a TEMPORARY self-signed certificate only when no certificate exists yet,
# so nginx can boot and serve the ACME http-01 challenge. Real certificates are
# then issued with infra/ssl/issue-certs.sh (certbot certonly --webroot) and
# renewed by the `certbot` service.
#
# Layout: the certbot_certs volume is mounted at /etc/letsencrypt in certbot and
# at /etc/nginx/ssl in nginx, so nginx reads /etc/nginx/ssl/live/<name>/...
# ==============================================================================
set -eu

CERT_NAME="${CERT_NAME:-gcdis.in}"
SSL_ROOT="${SSL_ROOT:-/etc/nginx/ssl}"
CERT_DIR="$SSL_ROOT/live/$CERT_NAME"

if [ -s "$CERT_DIR/fullchain.pem" ] && [ -s "$CERT_DIR/privkey.pem" ]; then
    # Older bootstrap certificates predate chain.pem; add it so nginx can start.
    if [ ! -s "$CERT_DIR/chain.pem" ] && [ -f "$CERT_DIR/.bootstrap-self-signed" ]; then
        cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/chain.pem"
    fi
    echo "[SSL Init] Certificates already exist at $CERT_DIR. Skipping bootstrap."
    exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "[SSL Init] openssl not found; installing (alpine)..."
    apk add --no-cache openssl >/dev/null
fi

echo "[SSL Init] No certificates found. Generating temporary self-signed bootstrap certificate..."
mkdir -p "$CERT_DIR"
umask 077
openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=$CERT_NAME/O=GCDIS bootstrap/C=IN"
chmod 644 "$CERT_DIR/fullchain.pem"
# nginx ssl_trusted_certificate (OCSP stapling) expects chain.pem, as certbot writes it.
cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/chain.pem"
chmod 644 "$CERT_DIR/chain.pem"
# Marker lets issue-certs.sh know it may replace this directory.
touch "$CERT_DIR/.bootstrap-self-signed"
echo "[SSL Init] Bootstrap certificate created. Run infra/ssl/issue-certs.sh to obtain a real certificate."
