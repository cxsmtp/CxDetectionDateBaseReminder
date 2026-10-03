#!/usr/bin/env bash
# Mixed-workload benchmark: VUS people at once (emailed reports, Dashboard,
# reminders, analytics, administrators) against a mock Checkmarx One.
#
#   loadtest/benchmark.sh [VUS=3000] [SECONDS=120]
#
# Environment:
#   LAT=80              Checkmarx One latency per call, ms
#   PROJECTS=200        projects in the mock tenant (60 findings each)
#   SERVER_CPUS=0-1     pin the server to these CPUs (taskset), to size a VM
#   GEN_CPUS=2-3        pin the mock tenant and the load generator elsewhere
#   SERVER_MEMORY_MB=   cap the server's JavaScript heap (--max-old-space-size)
#   BENCH_OUT=file.json write the results there as well
#   LABEL=text          a name for this run in the results
set -euo pipefail
cd "$(dirname "$0")/.."
VUS=${1:-3000}
SECONDS_=${2:-120}
PROJECTS=${PROJECTS:-200}
DATA=$(mktemp -d)
trap 'kill $MOCK $SERVER 2>/dev/null; wait 2>/dev/null; rm -rf "$DATA" 2>/dev/null || true' EXIT
pin() { if [ -n "${1:-}" ] && command -v taskset >/dev/null; then echo "taskset -c $1"; fi; }

KEY=$(node -e "const e=o=>Buffer.from(JSON.stringify(o)).toString('base64url');console.log(e({alg:'none'})+'.'+e({iss:'http://127.0.0.1:4101/auth/realms/acme',azp:'integration'})+'.sig')")
# Credits switched on and plenty allocated, so triage and remediation are limited by the server, not the budget.
node -e "
const fs=require('fs');
fs.writeFileSync('$DATA/settings.json', JSON.stringify({aiTriage:{enabled:true,remediationEnabled:true,monthlyCreditLimit:0}}));
const projects={}; for(let i=0;i<$PROJECTS;i++) projects['p'+i]={projectName:'Project '+i,triage:1e6,remediation:1e6,extraTriage:1e6,extraRemediation:1e6,version:2};
fs.writeFileSync('$DATA/credit-allocations.json', JSON.stringify({projects}));"

PORT=4101 PROJECTS=$PROJECTS LAT=${LAT:-80} $(pin "${GEN_CPUS:-}") node loadtest/mock-cxone.mjs & MOCK=$!
sleep 0.5
HEAP=${SERVER_MEMORY_MB:+--max-old-space-size=$SERVER_MEMORY_MB}
PORT=3997 HOST=127.0.0.1 DATA_DIR=$DATA BACKUP_INTERVAL_HOURS=0 REPORT_SIGNING_KEY=loadtest \
  CX_API_KEY=$KEY CX_BASE_URL=http://127.0.0.1:4101 CX_IAM_URL=http://127.0.0.1:4101 CX_TENANT=acme \
  ADMIN_EMAIL=admin@bench.io ADMIN_PASSWORD='temporary password 1' ACCEPT_TERMS=admin@bench.io SMTP_HOST= SMTP_USER= SMTP_PASS= \
  $(pin "${SERVER_CPUS:-}") node $HEAP src/server.js > "$DATA/server.log" 2>&1 & SERVER=$!
for _ in $(seq 1 100); do grep -q 'Successfully authenticated' "$DATA/server.log" 2>/dev/null && break; sleep 0.2; done

SERVER_PID=$SERVER REPORT_SIGNING_KEY=loadtest VUS=$VUS DURATION=$SECONDS_ PROJECTS=$PROJECTS \
  $(pin "${GEN_CPUS:-}") node loadtest/mixed-load.mjs || { echo "--- server log (tail)"; tail -40 "$DATA/server.log"; exit 1; }
