#!/usr/bin/env bash
# Test, build and publish SKRIEN to its server.
#   DEPLOY_HOST=user@server deploy/deploy.sh
# The SSH user needs sudo on the server. See deploy/install.sh for what runs there.
set -euo pipefail

host="${DEPLOY_HOST:?Set DEPLOY_HOST to the SSH target, for example user@server}"
cd "$(dirname "$0")/.."

npm test
npm run build

stage="$(ssh "$host" mktemp -d)"
trap 'ssh "$host" rm -rf "$stage"' EXIT
rsync -az --delete server.mjs package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.txt dist deploy "$host:$stage/"
ssh "$host" sudo bash "$stage/deploy/install.sh" "$stage"
