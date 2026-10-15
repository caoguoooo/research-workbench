#!/bin/sh
set -eu
release_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install=$release_root
compose() {
  if [ -f "$install/runtime/release.yaml" ]; then
    docker compose --project-directory "$install" -f "$install/compose.yaml" -f "$install/runtime/release.yaml" "$@"
  else
    docker compose --project-directory "$install" -f "$install/compose.yaml" "$@"
  fi
}
load_image() {
  if docker image inspect "$image" >/dev/null 2>&1; then return; fi
  archive="$release_root/caoguoooo-workbench-${image##*:}-amd64.tar.gz"
  if [ ! -f "$archive" ]; then printf '%s\n' "缺少镜像包：${archive}。请从同一 Release 下载并放在 workbench.sh 旁边。" >&2; return 1; fi
  gzip -dc "$archive" | docker load
  docker image inspect "$image" >/dev/null
}
prepare() {
  if [ -n "$(compose ps --status running -q app)" ]; then printf '%s\n' '请先停止服务，再初始化目录。' >&2; return 1; fi
  mkdir -p "$install/runtime/data" "$install/runtime/backups"
  temporary=$(mktemp "${TMPDIR:-/tmp}/workbench-init.XXXXXX")
  printf 'services:\n  app:\n    network_mode: none\n' > "$temporary"
  if ! compose -f "$temporary" run --rm -T --user 0:0 --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE app node scripts/prepare-data.mjs; then rm -f "$temporary"; return 1; fi
  rm -f "$temporary"
}
wait_healthy() {
  tries=0
  while [ "$tries" -lt 30 ]; do
    if compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    tries=$((tries+1)); sleep 2
  done
  printf '%s\n' '服务未通过健康检查，请查看日志。' >&2; return 1
}
backup_stopped() { compose run --rm --no-deps -T app node scripts/backup.mjs --json; }
backup() {
  running=$(compose ps --status running -q app)
  if [ -n "$running" ]; then compose stop app; trap 'compose up -d --no-build app' EXIT; fi
  backup_stopped
}
state() {
  docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add DAC_OVERRIDE --read-only --tmpfs /tmp \
    --mount "type=bind,src=$install/runtime,dst=/release-state" "$helper_image" node scripts/release-state.mjs /release-state "$@"
}
recover_upgrade() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ -n "${image_override:-}" ]; then rm -f "$image_override"; fi
  if [ "$result" -ne 0 ]; then
    if [ "${switched:-false}" = true ]; then
      compose stop app || printf '%s\n' '失败版本未能停止，请查看容器状态。' >&2
      state rollback >/dev/null || printf '%s\n' '自动切回失败，请使用升级前备份和原镜像。' >&2
    fi
    if [ -n "${was_running:-}" ]; then compose up -d --no-build app || printf '%s\n' '原服务未能恢复，请查看日志。' >&2; fi
  fi
  exit "$result"
}
upgrade() {
  [ -n "${1:-}" ] || { printf '%s\n' '用法：sh 新版本目录/workbench.sh upgrade 现有安装目录' >&2; return 1; }
  install=$(CDPATH= cd -- "$1" && pwd)
  [ -f "$install/compose.yaml" ] || { printf '%s\n' '目标不是已有安装目录，找不到 compose.yaml。' >&2; return 1; }
  version=$(sed -n 's/^  "version": "\([0-9][0-9.]*\)",*$/\1/p' "$release_root/package.json")
  case "$version" in ''|*[!0-9.]*) printf '%s\n' '版本号不正确' >&2; return 1;; esac
  image="caoguoooo-workbench:$version"; helper_image=$image
  load_image
  old_image=$(compose config --images)
  [ "$old_image" != "$image" ] || { printf '%s\n' '已经使用此版本。'; return; }
  mkdir -p "$install/runtime"
  was_running=$(compose ps --status running -q app); switched=false
  image_override=$(mktemp "${TMPDIR:-/tmp}/workbench-upgrade.XXXXXX")
  printf 'services:\n  app:\n    image: %s\n    network_mode: none\n' "$image" > "$image_override"
  trap recover_upgrade EXIT
  trap 'exit 130' HUP INT TERM
  compose stop app
  backup_record=$(compose -f "$image_override" run --rm --no-deps -T app node scripts/backup.mjs --json)
  state activate "$version" "$image" "$old_image" "$backup_record" >/dev/null
  switched=true
  rm -f "$image_override"
  compose up -d --no-build app
  wait_healthy
  if [ "$release_root" != "$install" ]; then cp "$release_root/workbench.sh" "$install/workbench.sh"; fi
  switched=false
  trap - EXIT HUP INT TERM
  printf '%s\n' "已升级到 ${version}，现有 compose.yaml、资料目录和账号保持不变。" "升级前备份：$backup_record"
}
rollback() {
  helper_image=$(compose config --images)
  previous=$(state previous)
  docker image inspect "$previous" >/dev/null
  was_running=$(compose ps --status running -q app); switched=false; image_override=''
  trap recover_upgrade EXIT
  trap 'exit 130' HUP INT TERM
  compose stop app
  backup_record=$(backup_stopped)
  state rollback >/dev/null; switched=true
  compose up -d --no-build app
  wait_healthy
  switched=false; trap - EXIT HUP INT TERM
  printf '%s\n' "已切回 ${previous}，资料原地保留。" "切回前备份：$backup_record"
}
case "${1:-help}" in
  init)
    image=$(compose config --images); load_image; prepare
    if compose run --rm --no-deps -T app node --input-type=module -e "import {access} from 'node:fs/promises';try{await access(process.env.WORKBENCH_DATA_DIR+'/auth.json')}catch{process.exit(1)}"; then
      printf '%s\n' '已有账号保留。'
    else compose run --rm --no-deps app npm run admin:init -- --username "${2:-admin}"; fi
    compose up -d --no-build app
    ;;
  upgrade) upgrade "${2:-}" ;;
  rollback) rollback ;;
  prepare) prepare ;;
  start) compose up -d --no-build app ;;
  stop) compose stop app ;;
  backup) backup ;;
  logs) compose logs --tail 50 app ;;
  status) compose ps ;;
  version) compose config --images ;;
  *) printf '%s\n' '首次安装：sh workbench.sh init [账号名]' '升级：sh 新版目录/workbench.sh upgrade 现有安装目录' '回退：sh workbench.sh rollback' '备份：sh workbench.sh backup' '启动/停止/状态/日志：sh workbench.sh start|stop|status|logs' ;;
esac
