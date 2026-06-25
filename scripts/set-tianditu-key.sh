#!/usr/bin/env bash
# 一键设置天地图 tk 密钥。写入 public/config.js（已 gitignore，绝不提交）。
# 用法: bash scripts/set-tianditu-key.sh <你的天地图tk>
set -euo pipefail
tk="${1:-}"
if [ -z "$tk" ]; then
  echo "用法: bash scripts/set-tianditu-key.sh <天地图tk>"
  echo "  （tk 在 https://console.tianditu.gov.cn 注册「浏览器端」应用后获取，"
  echo "    并把本地面站的访问地址/域名加入该应用的白名单/referer）"
  exit 1
fi
tk="$(printf '%s' "$tk" | tr -cd 'A-Za-z0-9')"
if [ -z "$tk" ]; then echo "✗ tk 非法（应为字母数字）"; exit 1; fi
out="$(cd "$(dirname "$0")/.." && pwd)/public/config.js"
printf '// 天地图密钥（gitignore，勿提交）。由 scripts/set-tianditu-key.sh 写入。\nwindow.TIANDITU_TK = "%s";\n' "$tk" > "$out"
echo "✓ 已写入天地图密钥 (${#tk} 字符) → $out"
echo "  刷新浏览器，左上角图层控件即出现「天地图·卫星(中文)」「天地图·街道(中文)」。"
echo "  无需重启 bridge（静态文件按请求读取）。"
