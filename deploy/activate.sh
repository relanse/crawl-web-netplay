#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

root=/opt/crawl-online
state=$root/.publish
matches=/var/lib/crawl-online/matches
progress=$matches/.progress
backups=/var/backups/crawl-online
health=http://127.0.0.1:8792/health
command=${SSH_ORIGINAL_COMMAND:-}

if [[ $command == status ]]; then
  curl -fsS --max-time 5 "$health"
  printf '\n'
  exit 0
fi
[[ $command =~ ^(check|publish)\ ([0-9a-f]{64})$ ]] || { echo 'Unsupported release command' >&2; exit 2; }
action=${BASH_REMATCH[1]}
expected=${BASH_REMATCH[2]}
exec 9>"$state/lock"
flock -n 9 || { echo 'A release is already in progress' >&2; exit 3; }

stage=$(mktemp -d "$state/upload.XXXXXXXX")
candidate= probe= backup= old= draining=0 rollback=0 started=0
phase=upload
point_current() {
  ln -s -- "$1" "$stage/current"
  mv -Tf -- "$stage/current" "$root/current"
}
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if ((code)); then echo "Release failed during $phase." >&2; fi
  if ((rollback)); then
    echo 'Activation failed; restoring the previous release.' >&2
    if ((started)); then
      systemctl stop crawl-online || exit 1
      if ! diff -qr -- "$backup/progress" "$progress" >/dev/null; then
        if [[ -e $progress ]]; then mv -T -- "$progress" "$backup/failed-progress" || exit 1; fi
        cp -a -- "$backup/progress" "$progress" || exit 1
      fi
    fi
    point_current "$old" || exit 1
    rm -f -- "$matches/.deploy-drain" "$matches/.deploy-switch"
    systemctl start crawl-online || exit 1
    local healthy=0
    for _ in {1..15}; do
      if curl -fsS --max-time 2 "$health" >/dev/null 2>&1; then healthy=1; break; fi
      sleep 1
    done
    ((healthy)) || { echo 'Previous release failed to start' >&2; exit 1; }
    echo 'Previous release is healthy.' >&2
  fi
  if ((draining)); then rm -f -- "$matches/.deploy-drain" "$matches/.deploy-switch"; fi
  if [[ -n $candidate ]]; then rm -rf -- "$candidate"; fi
  if [[ -n $probe ]]; then rm -rf -- "$probe"; fi
  rm -rf -- "$stage"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cat >"$stage/archive.tar.gz"
phase='archive verification'
printf '%s  %s\n' "$expected" "$stage/archive.tar.gz" | sha256sum --check --quiet
mkdir "$stage/payload"
metadata=$(python3 - "$stage/archive.tar.gz" "$stage/payload" <<'PY'
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

archive, target = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as bundle:
    entries = bundle.getmembers()
    names = set()
    for entry in entries:
        name = PurePosixPath(entry.name)
        if (not name.parts or name.is_absolute() or '..' in name.parts or
                name.parts[0] not in {'authority', 'client', 'server', 'release.json'} or
                not (entry.isfile() or entry.isdir()) or name in names):
            raise SystemExit('Release contains an invalid archive member')
        names.add(name)
    bundle.extractall(target, entries, filter='data')
base = Path(target)
def read(name):
    return json.loads((base/name).read_text(encoding='utf-8-sig'))
release, native, web = (read(name) for name in ('release.json', 'authority/build-report.json', 'client/client-build.json'))
commit, content = release['commit'], release['contentHash']
if (release['version'] != 1 or not re.fullmatch('[a-f0-9]{40}', commit) or
        not re.fullmatch('[a-f0-9]{64}', content) or
        native['kind'] != 'authority' or native['result'] != 'Succeeded' or
        web['kind'] != 'client' or native['contentHash'] != content or web['contentHash'] != content):
    raise SystemExit('Release manifest or Unity build pair is invalid')
for item in web['files'].values():
    file = PurePosixPath(item)
    if file.is_absolute() or '..' in file.parts or not (base/'client'/file).is_file():
        raise SystemExit('Missing published WebGL file')
for item in ('authority/CrawlServer.x86_64', 'server/online-server.mjs', 'server/online/index.html'):
    if not (base/item).is_file():
        raise SystemExit('Release is missing required application files')
print(commit, content)
PY
)
read -r commit content <<<"$metadata"
candidate=$(mktemp -d "$state/releases/${commit:0:12}.XXXXXXXX")
mv -- "$stage/payload/"* "$candidate/"
chgrp -R crawl-online "$candidate"
chmod -R g+rX,o-rwx "$candidate"
chmod 750 "$candidate/authority/CrawlServer.x86_64"

probe=$(mktemp -d "$stage/probe.XXXXXXXX")
phase='isolated startup'
chmod 711 "$stage"
chown crawl-online:crawl-online "$probe"
runuser -u crawl-online -- timeout 20 "$root/runtime/node" --input-type=module - "$candidate" "$probe" "$content" <<'NODE'
import {pathToFileURL} from 'node:url';
const [release,data,expected]=process.argv.slice(2);
const {createOnlineServer}=await import(pathToFileURL(release+'/server/online-server.mjs'));
const app=await createOnlineServer({executable:release+'/authority/CrawlServer.x86_64',
  web:release+'/client',directory:data,key:'local-release-smoke-check-only',publicOrigin:''});
try{
  const origin=await app.listen(0);
  const health=await (await fetch(origin+'/health')).json();
  if(!health.ok||health.contentHash!==expected||health.activeMatches!==0||health.deployDraining!==false)throw Error('Unexpected candidate health');
  const page=await fetch(origin+'/');
  if(!page.ok||!(await page.text()).includes('id="standings"'))throw Error('Candidate lobby is incomplete');
}finally{await app.close();}
NODE
if [[ $action == check ]]; then
  echo "Verified $commit with isolated data."
  exit 0
fi

systemctl show -p ExecStart --value crawl-online | grep -F -- ' --preserve-symlinks-main ' >/dev/null || {
  echo 'The active service configuration needs deploy/crawl-online-publish.conf.' >&2
  exit 1
}
old=$(readlink -f "$root/current")
phase='drain'
if [[ -f $root/current/release.json ]] && cmp -s "$root/current/release.json" "$candidate/release.json"; then
  echo "Release $commit is already installed."
  exit 0
fi
curl -fsS --max-time 5 "$health" >/dev/null
touch "$matches/.deploy-drain"
draining=1
# One legacy release predates the drain API. Its existing game processes still
# protect it during the first upgrade to a managed release.
for attempt in {0..180}; do
  current_health=$(curl -fsS --max-time 5 "$health")
  active=$(python3 -c 'import json,sys; h=json.load(sys.stdin); print(h["activeMatches"] if h.get("deployDraining") is True else "legacy")' <<<"$current_health")
  if [[ $active == 0 ]] || { [[ $active == legacy ]] && ! pgrep -u crawl-online -f '^/opt/crawl-online/(authority|current/authority)/CrawlServer[.]x86_64( |$)' >/dev/null; }; then break; fi
  ((attempt < 180)) || { echo 'A match is still active; release stopped without ending it.' >&2; exit 3; }
  if ((attempt == 0)); then echo 'Waiting for the active match to finish.'; fi
  sleep 5
done
touch "$matches/.deploy-switch"
phase='data backup'
rollback=1
systemctl stop crawl-online

backup=$(mktemp -d "$backups/$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}.XXXXXXXX")
cp -a -- "$progress" "$backup/progress"
python3 - "$backup/progress/online.sqlite" <<'PY'
from pathlib import Path
import sqlite3
import sys

backup = Path(sys.argv[1])
if not backup.is_file():
    raise SystemExit('Leaderboard database is missing from the backup')
with sqlite3.connect(backup.as_uri()+'?mode=ro', uri=True) as db:
    if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise SystemExit('Leaderboard backup failed its integrity check')
PY
diff -qr -- "$progress" "$backup/progress"
phase='activation'
point_current "$candidate"
started=1
systemctl start crawl-online
healthy=0
for _ in {1..15}; do
  if live=$(curl -fsS --max-time 2 "$health" 2>/dev/null) &&
    python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(not(data.get("ok") and data.get("contentHash")==sys.argv[1] and data.get("deployDraining") is True))' "$content" <<<"$live"; then
    healthy=1
    break
  fi
  sleep 1
done
((healthy)) || { echo 'The new release did not become healthy.' >&2; exit 1; }
retired=$(readlink "$state/previous" 2>/dev/null || true)
ln -s -- "$old" "$stage/previous"
mv -Tf -- "$stage/previous" "$state/previous"
rollback=0
candidate=
rm -f -- "$matches/.deploy-drain" "$matches/.deploy-switch"
draining=0
if [[ $retired =~ ^/opt/crawl-online/\.publish/releases/[0-9a-f]{12}\.[A-Za-z0-9]{8}$ && $retired != "$old" ]]; then
  rm -rf -- "$retired"
fi
echo "Published $commit"
echo "Data backup: $backup"
