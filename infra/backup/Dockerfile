# ==============================================================================
# GCDIS backup daemon image: pg_dump (same major as the database) + openssl + aws-cli
# baked in at build time, so the container no longer runs `apk add` on every start.
# Also ships the restore tooling used by the monthly restore drill
# (docs/security/backup-and-restore.md):
#   /usr/local/bin/restore.sh         decrypt + restore into a target database
#   /usr/local/bin/verify-restore.sh  restore the newest backup into a scratch DB
#                                     and compare row counts with the live DB
# Rebuild periodically to pick up security patches:
#   docker compose -f docker-compose.prod.yml build --pull backup
# ==============================================================================
FROM postgres:18-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5

RUN apk add --no-cache openssl aws-cli tar

COPY backup-daemon.sh restore.sh verify-restore.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup-daemon.sh /usr/local/bin/restore.sh /usr/local/bin/verify-restore.sh

ENTRYPOINT ["/usr/local/bin/backup-daemon.sh"]
