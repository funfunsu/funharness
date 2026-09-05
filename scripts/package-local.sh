#!/usr/bin/env bash
# 本地打包脚本（macOS/Linux）：清理旧 vsix -> 编译 -> 使用 vsce 打包（带版本号与时间戳）
# 用法：
#   ./scripts/package-local.sh
#   # 或
#   bash scripts/package-local.sh

set -euo pipefail

# 初始化 fnm 环境
if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)"
else
    echo "警告：未找到 fnm，尝试直接使用系统 node/npm" >&2
fi

# 定位仓库根目录与扩展目录（apps）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
WORKTREE_ROOT="$(dirname "$REPO_ROOT")"
APPS_DIR="$REPO_ROOT/apps"
# vsix 输出到项目根目录（project-structure）的上一级目录，与其平级
OUT_DIR="$(dirname "$WORKTREE_ROOT")"

if [ ! -d "$APPS_DIR" ]; then
    echo "错误：未找到扩展目录：$APPS_DIR" >&2
    exit 1
fi

pushd "$APPS_DIR" > /dev/null
trap 'popd > /dev/null' EXIT

# 0. 检查依赖是否已安装
if [ ! -d "$APPS_DIR/node_modules" ]; then
    echo "==> 安装依赖 (npm install)"
    npm install
fi

# 1. 清理输出目录下已有的 vsix
echo "==> 清理旧的 .vsix 文件（${OUT_DIR}）"
find "$OUT_DIR" -maxdepth 1 -name '*.vsix' -type f -print -delete 2>/dev/null || true

# 2. 编译
echo "==> 编译 (npm run compile)"
npm run compile

# 3. 读取版本号并生成带时间戳的输出文件名（输出到上一级目录）
VERSION="$(node -p "require('./package.json').version")"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_PATH="$OUT_DIR/fun-harness-$VERSION-$TIMESTAMP.vsix"

# 4. 打包
echo "==> 打包 $OUT_PATH"
npx @vscode/vsce package --allow-missing-repository --allow-star-activation -o "$OUT_PATH"

echo "==> 完成：$OUT_PATH"
