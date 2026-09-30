#!/usr/bin/env bash
# Load-test the report relay against a mock Checkmarx One.
#
#   loadtest/run.sh [READERS=1000] [SECONDS=60]
#
# Starts a mock tenant (200 projects × 60 findings, 80 ms per call), a reminder
# server on port 3997 with a throwaway data directory and generous credits,
# then simulates READERS open reports: each connects, reads credits and
# remediation state, 1 in 5 triages 5 findings, 1 in 20 remediates one, and all
# poll triage results every 6 s. Prints latency percentiles per endpoint,
# upstream calls to Checkmarx One, and server CPU / memory.
set -euo pipefail
cd "$(dirname "$0")/.."
READERS=${1:-1000}
SECONDS_=${2:-60}
DATA=$(mktemp -d)
trap 'kill $MOCK $SERVER $WATCH 2>/dev/null || true; rm -rf "$DATA"' EXIT

KEY=$(node -e "const e=o=>Buffer.from(JSON.stringify(o)).toString('base64url');console.log(e({alg:'none'})+'.'+e({iss:'http://127.0.0.1:4101/auth/realms/acme'})+'.sig')")
node -e "
const fs=require('fs');
fs.writeFileSync('$DATA/settings.json', JSON.stringify({aiTriage:{enabled:true,remediationEnabled:true,monthlyCreditLimit:0}}));
const projects={}; for(let i=0;i<200;i++) projects['p'+i]={projectName:'Project '+i,triage:1e6,remediation:1e6,extraTriage:1e6,extraRemediation:1e6,version:2};
fs.writeFileSync('$DATA/credit-allocations.json', JSON.stringify({projects}));"

KEY=$KEY LAT=${LAT:-80} node loadtest/mock-cxone.mjs & MOCK=$!
sleep 0.5
PORT=3997 HOST=127.0.0.1 REPORT_SIGNING_KEY=loadtest CX_API_KEY=$KEY CX_BASE_URL=http://127.0.0.1:4101 \
  CX_IAM_URL=http://127.0.0.1:4101 CX_TENANT=acme SETTINGS_FILE=$DATA/settings.json node src/server.js > "$DATA/server.log" 2>&1 & SERVER=$!
sleep 2.5
( while kill -0 $SERVER 2>/dev/null; do ps -o rss=,pcpu= -p $SERVER; sleep 2; done ) > "$DATA/usage.txt" & WATCH=$!

REPORT_SIGNING_KEY=loadtest READERS=$READERS DURATION=$SECONDS_ node loadtest/relay-load.mjs
awk '{ if ($1>m) m=$1; if ($2>c) c=$2 } END { printf "server peak: %.0f MB RSS, %s%% CPU\n", m/1024, c }' "$DATA/usage.txt"
