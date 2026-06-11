#!/bin/zsh
node --env-file=.env node_modules/.bin/tsx server.ts > /tmp/srv_out.txt 2>&1 &
SPID=$!
sleep 5
kill $SPID 2>/dev/null
echo "=== STDOUT+STDERR ==="
cat /tmp/srv_out.txt
echo "=== END ==="
