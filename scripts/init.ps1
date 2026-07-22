# 初始化脚本：安装项目依赖
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$appsDir = Join-Path $repoRoot 'apps'

if (-not (Test-Path $appsDir)) {
    Write-Error "未找到 apps 目录：$appsDir"
    exit 1
}

Push-Location $appsDir
try {
    Write-Host '==> 执行 npm install' -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install 失败 (exit $LASTEXITCODE)"
    }
    Write-Host '==> 完成 npm install' -ForegroundColor Green
}
finally {
    Pop-Location
}