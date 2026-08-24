#!/bin/sh
# Restarts the bot whenever it exits for any reason (crash, unhandled error,
# forced exit from a socket-mode failure) with a short backoff, so a flaky
# laptop network doesn't leave Meow down until someone notices.
cd "$(dirname "$0")/.."
while true; do
  node src/app.js
  echo "Meow exited ($?), restarting in 3s..."
  sleep 3
done
