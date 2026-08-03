# 本地打包脚本：清理旧 vsix -> 编译 -> 使用 vsce 打包（带版本号与时间戳）
# 用法：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/package-local.ps1
# 可配置到自定义按钮中执行。

$ErrorActionPreference = 'Stop'

# 初始化 fnm 环境
Invoke-Expression (fnm env --shell powershell | Out-String)

# 定位仓库根目录与扩展目录（apps）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$worktreeRoot  = Split-Path -Parent $repoRoot
$appsDir   = Join-Path $repoRoot 'apps'
# vsix 输出到项目根目录（project-structure）的上一级目录，与其平级
$outDir    = Split-Path -Parent $worktreeRoot

if (-not (Test-Path $appsDir)) {
    Write-Error "未找到扩展目录：$appsDir"
    exit 1
}

Push-Location $appsDir
try {
    # 0. 检查依赖是否已安装
    if (-not (Test-Path (Join-Path $appsDir 'node_modules'))) {
        Write-Host "==> 安装依赖 (npm install)" -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败 (exit $LASTEXITCODE)" }
    }

    # 1. 清理输出目录下已有的 vsix
    Write-Host "==> 清理旧的 .vsix 文件（$outDir）" -ForegroundColor Cyan
    Get-ChildItem -Path $outDir -Filter '*.vsix' -File -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "    删除 $($_.Name)"
        Remove-Item $_.FullName -Force
    }

    # 2. 编译
    Write-Host '==> 编译 (npm run compile)' -ForegroundColor Cyan
    npm run compile
    if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }

    # 3. 读取版本号并生成带时间戳的输出文件名（输出到上一级目录）
    $version   = node -p "require('./package.json').version"
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outPath   = Join-Path $outDir "fun-harness-$version-$timestamp.vsix"

    # 4. 打包
    Write-Host "==> 打包 $outPath" -ForegroundColor Cyan
    npx @vscode/vsce package --allow-missing-repository --allow-star-activation -o $outPath
    if ($LASTEXITCODE -ne 0) { throw "打包失败 (exit $LASTEXITCODE)" }

    Write-Host "==> 完成：$outPath" -ForegroundColor Green
}
finally {
    Pop-Location
}
