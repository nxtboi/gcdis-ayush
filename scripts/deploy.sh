#!/bin/sh
# ==============================================================================
# GCDIS production deploy with automatic rollback (runs ON the production host,
# from the repository checkout; invoked over SSH by .github/workflows/ci-cd.yml).
#
#   IMAGE_PREFIX=ghcr.io/<owner> IMAGE_TAG=<git-sha> sh scripts/deploy.sh
#
# 1. records the currently deployed tag (.deploy/current-tag)
# 2. pulls the new images, runs the one-shot `migrate` job, recreates services
# 3. waits for the api/web/admin/proxy healthchecks
# 4. on failure, redeploys the previous tag and exits non-zero
#
# NOTE: database migrations are forward-only; a rollback restores the previous
# application images but does not revert schema changes. Keep migrations
# backwards-compatible (expand/contract).
# Prerequisites (one-time, manual): `docker login ghcr.io` on the host with a
# read:packages token, and a populated .env next to docker-compose.prod.yml.
# ==============================================================================
set -eu

: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${IMAGE_PREFIX:?IMAGE_PREFIX is required (e.g. ghcr.io/<owner>)}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STATE_DIR="${STATE_DIR:-.deploy}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
SERVICES_TO_CHECK="gcdis-api gcdis-web gcdis-admin gcdis-proxy"

mkdir -p "$STATE_DIR"
PREVIOUS_TAG="$(cat "$STATE_DIR/current-tag" 2>/dev/null || echo "")"

export IMAGE_PREFIX
dc() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

wait_healthy() {
  _deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  for c in $SERVICES_TO_CHECK; do
    while :; do
      _status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"
      if [ "$_status" = "healthy" ]; then
        echo "[deploy] $c healthy"
        break
      fi
      if [ "$(date +%s)" -ge "$_deadline" ]; then
        echo "[deploy] $c not healthy (status: $_status) within ${HEALTH_TIMEOUT}s" >&2
        return 1
      fi
      sleep 5
    done
  done
}

deploy_tag() {
  IMAGE_TAG="$1"
  export IMAGE_TAG
  echo "[deploy] Deploying ${IMAGE_PREFIX}/gcdis-*:${IMAGE_TAG}"
  # errexit is suspended inside `if` conditions, so every step returns explicitly.
  dc pull web admin api migrate || return 1
  # Backup image is small and host-built from infra/backup (not published by CI).
  dc build backup || return 1
  # `migrate` runs automatically as an api dependency; --no-build ensures the
  # pulled CI images are used rather than rebuilding app images on the host.
  dc up -d --no-build --remove-orphans || return 1
  # nginx resolves the app containers once at start: reload it so it picks up the recreated containers
  # (otherwise stale addresses give 502s until the next scheduled reload).
  dc exec -T proxy nginx -s reload || echo "[deploy] warning: nginx reload failed; the proxy picks up new containers at its next reload" >&2
}

if deploy_tag "$IMAGE_TAG" && wait_healthy; then
  echo "$IMAGE_TAG" > "$STATE_DIR/current-tag"
  [ -n "$PREVIOUS_TAG" ] && echo "$PREVIOUS_TAG" > "$STATE_DIR/previous-tag"
  echo "[deploy] Release ${IMAGE_TAG} is live."
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "[deploy] Release ${IMAGE_TAG} FAILED health verification." >&2
dc logs --tail 100 api migrate >&2 || true

if [ -z "$PREVIOUS_TAG" ]; then
  echo "[deploy] No previous tag recorded; cannot roll back automatically." >&2
  exit 1
fi

echo "[deploy] Rolling back to ${PREVIOUS_TAG}..." >&2
if deploy_tag "$PREVIOUS_TAG" && wait_healthy; then
  echo "[deploy] Rollback to ${PREVIOUS_TAG} succeeded." >&2
else
  echo "[deploy] ROLLBACK FAILED - manual intervention required." >&2
fi
exit 1
