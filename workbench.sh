#!/bin/sh
set -eu
cd "$(dirname "$0")"
compose() { docker compose "$@"; }

prepare() {
  if [ -n "$(compose ps --status running -q app)" ]; then
    printf '%s\n' '请先执行 sh workbench.sh stop，再初始化或恢复资料。' >&2
    return 1
  fi
  init_config=$(mktemp "${TMPDIR:-/tmp}/workbench-init.XXXXXX")
  printf 'services:\n  app:\n    network_mode: none\n' > "$init_config"
  if ! COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}:$init_config" compose run --rm -T --user 0:0 --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --volume "${WORKBENCH_SEED_DIR:-$PWD/demo-data}:/seed:ro" app node scripts/prepare-data.mjs; then
    rm -f "$init_config"
    return 1
  fi
  rm -f "$init_config"
}

backup() {
  restart_app=$(compose ps --status running -q app)
  if [ -n "$restart_app" ]; then
    compose stop app
    trap 'compose up -d app' EXIT
  fi
  compose run --rm -T app npm run backup
}

case "${1:-help}" in
  init)
    image=$(compose config --images)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      archive="research-workbench-${image##*:}-amd64.tar.gz"
      if [ -f "$archive" ]; then
        gzip -dc "$archive" | docker load
      else
        compose build app
      fi
    fi
    docker image inspect "$image" >/dev/null
    prepare
    if compose run --rm -T app node --input-type=module -e "import {access} from 'node:fs/promises';try{await access(process.env.CYJ_DATA_DIR+'/auth.json')}catch{process.exit(1)}"; then
      printf '%s\n' '已有账号保留。'
    else
      compose run --rm app npm run admin:init -- --username "${2:-workspace}"
    fi
    compose up -d app
    ;;
  prepare) prepare ;;
  start) compose up -d app ;;
  stop) compose stop app ;;
  backup) backup ;;
  logs) compose logs --tail 50 app ;;
  status) compose ps ;;
  *) printf '%s\n' '首次安装：sh workbench.sh init [账号名]' '启动：sh workbench.sh start' '停止：sh workbench.sh stop' '备份：sh workbench.sh backup' '状态：sh workbench.sh status' '日志：sh workbench.sh logs' ;;
esac
