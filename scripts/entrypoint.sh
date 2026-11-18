#!/bin/sh
# Runs as root only to prepare the data volume, then drops privileges for everything else.
#
# Hold until the volume has been prepared. An existing user's files must be in place before anything opens
# the database or the WhatsApp session, so a new machine waits here for /data/.seeded:
#   existing data: upload the files, then `touch /data/.seeded`
#   new user:      set CLOCKWORK_FRESH=1
mkdir -p /data
if [ ! -e /data/.seeded ]; then
  if [ "${CLOCKWORK_FRESH:-}" = "1" ]; then touch /data/.seeded
  else echo "waiting for /data/.seeded (seed the volume, then create that file)"; while [ ! -e /data/.seeded ]; do sleep 3; done; echo "volume seeded"; fi
fi
chown -R clockwork:clockwork /data && chmod 700 /data
exec gosu clockwork run-instance
