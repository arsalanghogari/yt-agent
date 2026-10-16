#!/bin/sh
# Run every check: sh tests/run.sh
set -e
cd "$(dirname "$0")"
for t in *.test.mjs; do node "$t"; done
