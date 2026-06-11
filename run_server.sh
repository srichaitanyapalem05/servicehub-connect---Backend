#!/bin/zsh
node --env-file=.env node_modules/.bin/tsx server.ts
echo "EXIT CODE: $?"
