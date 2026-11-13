#!/usr/bin/env bash
# LSP Claude Code не следует за сменой каталога сессии; убитый, он поднимется заново в текущем cwd при следующем вызове.
set -u
[ -d /proc/self ] || exit 0

input=$( [ -t 0 ] || cat )
field() { printf '%s' "$input" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed 's/^"[^"]*":"//; s/"$//'; }

LSP_NAME='language-?server|langserver|-ls$|^(gopls|rust-analyzer|clangd|jdtls|pylsp|tsserver(\.js)?|OmniSharp)$'

argv() { tr '\0' '\n' < /proc/"$1"/cmdline 2>/dev/null | head -2; }
is_lsp() {
  local a
  while IFS= read -r a; do [[ ${a##*/} =~ $LSP_NAME ]] && return 0; done < <(argv "$1")
  return 1
}
is_claude() {
  [ "$(cat /proc/"$1"/comm 2>/dev/null)" = claude ] && return 0
  argv "$1" | grep -qE '(^|/)claude$|claude-code/cli\.js$'
}
session_of() {
  local p=$1
  while [ "${p:-0}" -gt 1 ]; do
    is_claude "$p" && { echo "$p"; return; }
    p=$(awk '{print $4}' /proc/"$p"/stat 2>/dev/null)
  done
}
tree() {
  echo "$1"
  local c
  for c in $(pgrep -P "$1"); do tree "$c"; done
}

tool=$(field tool_name)
here=$(field cwd)
moved=
case $tool in EnterWorktree|ExitWorktree) [ -n "$here" ] && moved=1 ;; esac

if [ "${1:-}" = --all ]; then
  roots=$(pgrep -u "$(id -u)" -x claude)
  moved=
else
  roots=${LSP_REAP_ROOT:-$(session_of "$PPID")}
fi
[ -n "$roots" ] || exit 0

reaped=()
for root in $roots; do
  for p in $(pgrep -P "$root"); do
    is_lsp "$p" || continue
    cwd=$(readlink /proc/"$p"/cwd 2>/dev/null) || continue
    case $cwd in
      *' (deleted)') ;;
      "$here") continue ;;
      *) [ -n "$moved" ] || continue ;;
    esac
    kill -TERM $(tree "$p") 2>/dev/null
    reaped+=("$p ${cwd% (deleted)}")
  done
done

[ ${#reaped[@]} -eq 0 ] && exit 0
msg=$(printf '%s; ' "${reaped[@]}")
msg="LSP перезапустится в текущем каталоге, остановлен прежний: ${msg%; }"
msg=${msg//\\/\\\\}
printf '{"systemMessage":"%s"}\n' "${msg//\"/\\\"}"
