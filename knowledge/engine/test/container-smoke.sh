#!/usr/bin/env bash
# The container's control server (container/server.py) and the parts of ops.py that run before Cognee is imported,
# in the image's base (Python 3.12 on Linux, for /proc), without building the 3.5 GB image: health, the inbox, jobs,
# the checksum manifest, files and text, cleanup and quiesce, the query process's lifecycle, and the import's
# fail paths (a type Insulin can't read, a crash on one file, a detector error). Cognee's databases are not
# exercised: they run only on Cloudflare (README.md, "Build gotchas").
#
#   test/container-smoke.sh            needs Docker
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
base="$(sed -n 's/^FROM //p' "$here/container/Dockerfile" | head -1)"
name="knowledge-engine-smoke-$$"
port="${SMOKE_PORT:-18080}"

docker run -d --rm --name "$name" -p "127.0.0.1:$port:8080" \
  -v "$here/container:/app:ro" -w /app \
  -e KNOWLEDGE_TEST_CONTROLS=1 -e KNOWLEDGE_DATA_FORMAT=smoke-1 \
  "$base" sh -c 'mkdir -p /data && exec python /app/server.py' >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

url="http://127.0.0.1:$port"
for _ in $(seq 1 60); do curl -fs "$url/health" >/dev/null 2>&1 && break; sleep 0.5; done

fails=0
check() { # check <name> <command...>
  local label="$1"; shift
  if "$@"; then echo "ok   $label"; else echo "FAIL $label"; fails=$((fails + 1)); fi
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }
wait_job() { # wait_job <id> -> the finished job's JSON
  local body
  for _ in $(seq 1 100); do
    body="$(curl -fs "$url/jobs/$1")"
    [ "$(echo "$body" | json "d['state']")" != running ] && { echo "$body"; return; }
    sleep 0.2
  done
  echo "$body"
}
batch() { # batch <id> <json>
  curl -fs -X PUT --data-binary "$2" "$url/inbox/$1/batch.json" >/dev/null
}
start() { curl -fs -X POST -H 'content-type: application/json' -d "{\"op\":\"$1\",\"args\":{\"batchId\":\"$2\"}}" "$url/jobs" | json "d['id']"; }
rules='{"emails":true,"phones":true,"cards":true,"apiKeys":true,"secrets":true,"words":[]}'

check "health names the data format" test "$(curl -fs "$url/health" | json "d['dataFormat']")" = smoke-1

# A type Insulin can't read: refused for good, the original deleted as soon as it was read.
curl -fs -X PUT --data-binary 'PK' "$url/inbox/b1/f1" >/dev/null
batch b1 "{\"importId\":\"b1\",\"kind\":\"import\",\"files\":[{\"fileId\":\"f1\",\"documentId\":\"d1\",\"name\":\"Budget.xlsm\",\"type\":\"application/vnd.ms-excel.sheet.macroEnabled.12\"}],\"notes\":[],\"hiding\":$rules}"
job="$(wait_job "$(start ingest b1)")"
check "unreadable type fails" test "$(echo "$job" | json "d['state']")" = failed
check "with its reason" test "$(echo "$job" | json "d['result']['reason']")" = "“Budget.xlsm” is a type Insulin can't read."
check "permanently, naming the file" test "$(echo "$job" | json "(d['result']['permanent'], d['result']['failedFileId'])")" = "(True, 'f1')"
check "the original is gone" test "$(curl -fs "$url/quiesce" | json "d['inboxFiles']")" = 1 # batch.json only

# A crash on one file (IMP-05): no result, but the progress names it.
curl -fs -X PUT --data-binary '# Doc' "$url/inbox/b2/f2" >/dev/null
batch b2 "{\"importId\":\"b2\",\"kind\":\"import\",\"files\":[{\"fileId\":\"f2\",\"documentId\":\"d2\",\"name\":\"a.md\",\"type\":\"text/markdown\"}],\"notes\":[],\"hiding\":$rules,\"test\":{\"crashFileId\":\"f2\"}}"
job="$(wait_job "$(start ingest b2)")"
check "a crash fails the job" test "$(echo "$job" | json "(d['state'], d['exitCode'])")" = "('failed', 70)"
check "and its progress names the file" test "$(echo "$job" | json "d['progress']['current']")" = f2

# A detector error (HID-02): the import stops before anything is stored.
curl -fs -X PUT --data-binary 'Mail dana@example.com' "$url/inbox/b3/f3" >/dev/null
batch b3 "{\"importId\":\"b3\",\"kind\":\"import\",\"files\":[{\"fileId\":\"f3\",\"documentId\":\"d3\",\"name\":\"a.md\",\"type\":\"text/markdown\"}],\"notes\":[],\"hiding\":$rules,\"test\":{\"detectorError\":true}}"
job="$(wait_job "$(start ingest b3)")"
check "a detector error fails closed" test "$(echo "$job" | json "d['result']['reason']")" = "Hiding sensitive information failed, so nothing from this import was stored."
check "nothing was stored" test "$(curl -s -o /dev/null -w '%{http_code}' "$url/text/d3")" = 404

# A file that reads: its redacted text is written and the progress says "read" before learning starts (learning
# itself needs Cognee, which this base image doesn't have, so the job then stops).
curl -fs -X PUT --data-binary 'Write to dana.reyes@example.com about the gateway.' "$url/inbox/b4/f4" >/dev/null
batch b4 "{\"importId\":\"b4\",\"kind\":\"import\",\"files\":[{\"fileId\":\"f4\",\"documentId\":\"d4\",\"name\":\"a.md\",\"type\":\"text/markdown\"}],\"notes\":[],\"hiding\":$rules}"
job="$(wait_job "$(start ingest b4)")"
check "everything read before learning" test "$(echo "$job" | json "d['progress']['read']")" = True
check "the saved text is redacted" test "$(curl -fs "$url/text/d4" | json "d['text']")" = "Write to [hidden] about the gateway."

# Files under /data, the manifest, cleanup and quiesce.
curl -fs -X PUT --data-binary 'hello' "$url/files/system/databases/a.bin" >/dev/null
check "a file comes back" test "$(curl -fs "$url/files/system/databases/a.bin")" = hello
check "paths stay under /data" test "$(curl -s -o /dev/null -w '%{http_code}' "$url/files/..%2Fetc%2Fpasswd")" = 404
job="$(wait_job "$(curl -fs -X POST -H 'content-type: application/json' -d '{"op":"manifest"}' "$url/jobs" | json "d['id']")")"
check "the manifest lists it" test "$(echo "$job" | json "sorted(d['result']['entries'])")" = "['system/databases/a.bin', 'text/d4.json']"
check "not quiescent while something is staged" test "$(curl -fs "$url/quiesce" | json "d['quiescent']")" = False
curl -fs -X POST "$url/cleanup" >/dev/null
check "quiescent after cleanup" test "$(curl -fs "$url/quiesce" | json "d['quiescent']")" = True

# The query process: it starts, and without Cognee in this base image it reports that it failed; it stops.
curl -fs -X POST "$url/query/start" >/dev/null
check "a running query process blocks database jobs" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{"op":"stats"}' "$url/jobs")" = 409
for _ in $(seq 1 50); do [ "$(curl -fs "$url/query/status" | json "d['state']")" = failed ] && break; sleep 0.2; done
check "the query process reports its failure" test "$(curl -fs "$url/query/status" | json "d['state']")" = failed
curl -fs -X POST "$url/query/stop" >/dev/null
check "and stops" test "$(curl -fs "$url/query/status" | json "d['state']")" = stopped

if [ "$fails" -gt 0 ]; then echo "$fails failed"; exit 1; fi
echo "container smoke: all checks passed"
