#!/bin/sh
# Retrain the student once a day and tell the scorer to load the new head if it was promoted.
while true; do
  python train.py && python -c "import urllib.request,os; urllib.request.urlopen(urllib.request.Request(os.environ.get('CLOCKWORK_STUDENT_URL','http://student:4601')+'/reload', data=b'{}', method='POST'))" || echo "retrain failed"
  sleep "${CLOCKWORK_RETRAIN_SECONDS:-86400}"
done
