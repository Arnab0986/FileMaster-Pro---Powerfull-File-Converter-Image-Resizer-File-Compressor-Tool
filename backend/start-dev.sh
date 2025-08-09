#!/usr/bin/env bash
# Quick dev startup script
cd "$(dirname "$0")"
npm install
# use nodemon if installed globally; fallback to node
if command -v nodemon >/dev/null 2>&1; then
  nodemon server.js
else
  node server.js
fi