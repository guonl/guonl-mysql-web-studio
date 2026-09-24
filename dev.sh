#!/usr/bin/env bash
# =============================================================
# MySQL Web Studio 开发服务控制脚本
#
# 用法:
#   ./dev.sh start    启动服务（后台运行，日志写入 dev.log）
#   ./dev.sh stop     停止服务（自动清理挂起/残留进程）
#   ./dev.sh restart  重启服务
#   ./dev.sh status   查看运行状态
#   ./dev.sh log      实时查看日志（Ctrl+C 退出，不影响服务）
#
# 说明:
#   后台启动使用 nohup + stdin 重定向 /dev/null，
#   避免 Vite 读终端 stdin 被内核 SIGTTIN 挂起（裸 & 的坑）。
# =============================================================

PORT=5188
PID_FILE=".dev.pid"
LOG_FILE="dev.log"
URL="http://localhost:${PORT}/"

cd "$(dirname "$0")" || exit 1

# ---------- 工具函数 ----------

# 端口上监听的进程 PID（可能为空）
port_pids() {
  lsof -nP -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null
}

# PID 文件中记录的、且仍存活的进程 PID
file_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return
    fi
  fi
  echo ""
}

# 服务是否在运行（端口有监听即认为在运行）
is_running() {
  [ -n "$(port_pids)" ]
}

# 等待 HTTP 就绪（最多约 30 秒）
wait_ready() {
  local i
  for i in $(seq 1 60); do
    if curl -s -o /dev/null --max-time 1 "$URL"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# ---------- 子命令 ----------

do_start() {
  if is_running; then
    echo "服务已在运行: $URL (PID: $(port_pids | tr '\n' ' '))"
    exit 0
  fi

  if [ ! -d node_modules ]; then
    echo "未找到 node_modules，请先执行: npm install"
    exit 1
  fi

  echo "启动中: npm run dev (端口 ${PORT}) ..."
  # stdin 指向 /dev/null 是关键：防止 Vite 监听键盘被 SIGTTIN 挂起
  nohup npm run dev > "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"

  if wait_ready; then
    echo "启动成功: $URL"
    echo "日志: $(pwd)/$LOG_FILE  (./dev.sh log 可实时查看)"
  else
    echo "启动失败，最近日志如下（完整日志见 $LOG_FILE）:"
    echo "----------------------------------------"
    tail -n 20 "$LOG_FILE"
    echo "----------------------------------------"
    do_stop_quiet
    exit 1
  fi
}

# 静默停止（启动失败回滚时使用，不输出过程）
do_stop_quiet() {
  local pids
  pids="$(port_pids)"
  [ -n "$pids" ] && kill $pids 2>/dev/null
  rm -f "$PID_FILE"
}

do_stop() {
  # 1) 端口上监听的进程（真正的服务进程）
  # 2) PID 文件记录的进程（npm 父进程，兜底）
  local pids fp
  pids="$(port_pids)"
  fp="$(file_pid)"
  [ -n "$fp" ] && pids="$pids $fp"

  if [ -z "${pids// /}" ]; then
    echo "服务未在运行"
    rm -f "$PID_FILE"
    return
  fi

  echo "停止服务 (PID: $(echo $pids | tr ' ' '\n' | sort -u | tr '\n' ' ')) ..."
  kill $pids 2>/dev/null

  # 最多等 5 秒优雅退出，否则强杀
  local i
  for i in $(seq 1 10); do
    if [ -z "$(port_pids)" ]; then break; fi
    sleep 0.5
  done
  if [ -n "$(port_pids)" ]; then
    kill -9 $(port_pids) 2>/dev/null
  fi

  rm -f "$PID_FILE"
  echo "已停止"
}

do_status() {
  echo "MySQL Web Studio 开发服务"
  echo "-------------------------"
  local pp fp http
  pp="$(port_pids | tr '\n' ' ')"
  if [ -n "$pp" ]; then
    echo "状态: 运行中 (PID: $pp)"
    echo "端口: ${PORT} 监听中"
    if http=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$URL"); then
      echo "HTTP: $http  地址: $URL"
    else
      echo "HTTP: 无响应（进程可能挂起，可执行 ./dev.sh restart 修复）"
    fi
  else
    fp="$(file_pid)"
    if [ -n "$fp" ]; then
      echo "状态: 异常 — PID 文件存在($fp)但端口 ${PORT} 无监听"
      echo "处理: 执行 ./dev.sh start 重新启动"
    else
      echo "状态: 未运行"
    fi
  fi
}

# ---------- 入口 ----------

case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; echo ""; do_start ;;
  status)  do_status ;;
  log)     [ -f "$LOG_FILE" ] && tail -f "$LOG_FILE" || echo "暂无日志（服务未启动过）" ;;
  *)       sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; echo "当前状态:"; do_status ;;
esac
