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
# 共享依赖目录：放在 worktrees 同级（即项目根）下，避免单个 worktree 删除时丢失依赖
$sharedDepsRoot = Join-Path $outDir '.shared-deps'
$legacySharedNodeModulesDir = Join-Path $sharedDepsRoot 'fun-harness-apps-node_modules'
$sharedNodeModulesRoot = Join-Path $sharedDepsRoot 'fun-harness-apps'
$sharedNodeModulesDir = Join-Path $sharedNodeModulesRoot 'node_modules'
$sharedNpmCacheDir = Join-Path $sharedDepsRoot 'npm-cache'

function Ensure-NodeModulesJunction {
    param(
        [string]$NodeModulesDir,
        [string]$SharedNodeModulesDir,
        [bool]$EnableShared
    )

    if (-not $EnableShared) {
        return
    }

    if (-not (Test-Path $NodeModulesDir)) {
        New-Item -ItemType Junction -Path $NodeModulesDir -Target $SharedNodeModulesDir | Out-Null
        return
    }

    $item = Get-Item -LiteralPath $NodeModulesDir -Force
    $isReparsePoint = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    if ($isReparsePoint) {
        return
    }

    # npm 在某些版本会把 junction 识别成 "non-directory" 并替换为真实目录。
    # 这里自动回补为共享目录联接，避免后续每个 worktree 各自膨胀。
    Write-Host "==> 检测到 node_modules 已变为本地目录，自动回补共享联接" -ForegroundColor Yellow
    $tempBackup = "${NodeModulesDir}.local-backup"
    if (Test-Path $tempBackup) {
        Remove-Item -LiteralPath $tempBackup -Recurse -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $NodeModulesDir -Destination $tempBackup
    if (-not (Test-Path $SharedNodeModulesDir)) {
        New-Item -ItemType Directory -Path $SharedNodeModulesDir -Force | Out-Null
    }
    # Always sync freshly installed local modules into shared target. Do not skip when
    # shared dir already has content, otherwise new deps may be lost.
    if (Get-Command robocopy -ErrorAction SilentlyContinue) {
        $null = & robocopy $tempBackup $SharedNodeModulesDir /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1
        $robocopyExit = $LASTEXITCODE
        if ($robocopyExit -gt 7) {
            throw "robocopy 同步共享 node_modules 失败 (exit $robocopyExit)"
        }
    } else {
        Get-ChildItem -LiteralPath $tempBackup -Force -ErrorAction SilentlyContinue | ForEach-Object {
            $dest = Join-Path $SharedNodeModulesDir $_.Name
            if (Test-Path $dest) {
                Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
            }
            Move-Item -LiteralPath $_.FullName -Destination $dest -Force
        }
    }
    Remove-Item -LiteralPath $tempBackup -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Junction -Path $NodeModulesDir -Target $SharedNodeModulesDir | Out-Null
}

if (-not (Test-Path $appsDir)) {
    Write-Error "未找到扩展目录：$appsDir"
    exit 1
}

Push-Location $appsDir
try {
    # 0. 检查依赖并确保 tsc 可用（默认使用共享 node_modules）
    $nodeModulesDir = Join-Path $appsDir 'node_modules'
    $tscCmd = Join-Path $appsDir 'node_modules/.bin/tsc.cmd'
    $packageLockPath = Join-Path $appsDir 'package-lock.json'

    if (-not (Test-Path $sharedNpmCacheDir)) {
        New-Item -ItemType Directory -Path $sharedNpmCacheDir -Force | Out-Null
    }

    # 兼容旧共享目录命名：fun-harness-apps-node_modules -> fun-harness-apps/node_modules
    if ((Test-Path $legacySharedNodeModulesDir) -and (-not (Test-Path $sharedNodeModulesDir))) {
        New-Item -ItemType Directory -Path $sharedNodeModulesRoot -Force | Out-Null
        Move-Item -LiteralPath $legacySharedNodeModulesDir -Destination $sharedNodeModulesDir
        Write-Host "==> 已迁移旧共享依赖目录到标准路径：$sharedNodeModulesDir" -ForegroundColor Cyan
    }

    $npmCommonArgs = @(
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        '--progress=false',
        "--cache=$sharedNpmCacheDir"
    )
    $npmRegistry = ''
    if ($env:FUN_HARNESS_NPM_REGISTRY) {
        $npmRegistry = $env:FUN_HARNESS_NPM_REGISTRY.Trim()
    }
    if ($npmRegistry) {
        $npmCommonArgs += "--registry=$npmRegistry"
        Write-Host "==> 使用自定义 npm registry: $npmRegistry" -ForegroundColor DarkCyan
    }

    # 企业证书/代理场景：支持显式 CA 文件与 strict-ssl 覆盖。
    # 推荐：设置 FUN_HARNESS_NPM_CAFILE，避免关闭证书校验。
    $npmCaFile = ''
    if ($env:FUN_HARNESS_NPM_CAFILE) {
        $npmCaFile = $env:FUN_HARNESS_NPM_CAFILE.Trim()
    }
    if ($npmCaFile) {
        if (-not (Test-Path $npmCaFile)) {
            throw "FUN_HARNESS_NPM_CAFILE 指向的证书文件不存在：$npmCaFile"
        }
        $npmCommonArgs += "--cafile=$npmCaFile"
        Write-Host "==> 使用自定义 CA 证书：$npmCaFile" -ForegroundColor DarkCyan
    }

    if ($env:FUN_HARNESS_NPM_STRICT_SSL -eq '0') {
        $npmCommonArgs += '--strict-ssl=false'
        Write-Host '==> 已关闭 strict-ssl（仅建议临时排障使用）' -ForegroundColor Yellow
    }

    # 可选开关：设置 FUN_HARNESS_DISABLE_SHARED_NODE_MODULES=1 可禁用共享依赖策略
    $disableSharedNodeModules = ($env:FUN_HARNESS_DISABLE_SHARED_NODE_MODULES -eq '1')
    if (-not $disableSharedNodeModules) {
        if (-not (Test-Path $sharedNodeModulesDir)) {
            Write-Host "==> 初始化共享依赖目录：$sharedNodeModulesDir" -ForegroundColor Cyan
            New-Item -ItemType Directory -Path $sharedNodeModulesDir -Force | Out-Null
        }

        # 优先把 apps/node_modules 建成指向共享目录的目录联接（Windows）
        if (-not (Test-Path $nodeModulesDir)) {
            Write-Host "==> 创建共享 node_modules 联接" -ForegroundColor Cyan
            New-Item -ItemType Junction -Path $nodeModulesDir -Target $sharedNodeModulesDir | Out-Null
        } else {
            $nodeModulesItem = Get-Item -LiteralPath $nodeModulesDir -Force
            $isReparsePoint = (($nodeModulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
            if (-not $isReparsePoint) {
                Write-Host "==> 检测到本地 node_modules（非联接），继续使用本地目录；如需共享请先手工迁移并删除该目录" -ForegroundColor Yellow
                Write-Host "    建议一次性迁移：" -ForegroundColor Yellow
                Write-Host "    1) Remove-Item -LiteralPath '$nodeModulesDir' -Recurse -Force" -ForegroundColor Yellow
                Write-Host "    2) New-Item -ItemType Junction -Path '$nodeModulesDir' -Target '$sharedNodeModulesDir'" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host '==> 已禁用共享 node_modules 策略（FUN_HARNESS_DISABLE_SHARED_NODE_MODULES=1）' -ForegroundColor Yellow
    }

    if (-not (Test-Path $nodeModulesDir)) {
        if (Test-Path $packageLockPath) {
            Write-Host "==> 安装依赖 (npm ci, 离线优先)" -ForegroundColor Cyan
            npm ci @npmCommonArgs
        } else {
            Write-Host "==> 安装依赖 (npm install, 离线优先)" -ForegroundColor Cyan
            npm install @npmCommonArgs
        }
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败 (exit $LASTEXITCODE)" }
        Ensure-NodeModulesJunction -NodeModulesDir $nodeModulesDir -SharedNodeModulesDir $sharedNodeModulesDir -EnableShared (-not $disableSharedNodeModules)
    }

    if (-not (Test-Path $tscCmd)) {
        Write-Host "==> 未检测到 tsc，补装开发依赖 (npm install --include=dev, 离线优先)" -ForegroundColor Yellow
        npm install --include=dev @npmCommonArgs
        if ($LASTEXITCODE -ne 0) { throw "安装开发依赖失败 (exit $LASTEXITCODE)" }
        Ensure-NodeModulesJunction -NodeModulesDir $nodeModulesDir -SharedNodeModulesDir $sharedNodeModulesDir -EnableShared (-not $disableSharedNodeModules)
    }

    if (-not (Test-Path $tscCmd)) {
        throw "未找到 tsc：$tscCmd。请检查 npm 配置（例如 NODE_ENV / npm_config_production）后重试。"
    }

    # 某些 npm/reify 路径下可能出现 @types/node 已存在但 transitive 依赖 undici-types 缺失。
    # 这里做一次轻量自愈，避免编译阶段直接失败。
    $nodeTypesDir = Join-Path $nodeModulesDir '@types/node'
    $undiciTypesDir = Join-Path $nodeModulesDir 'undici-types'
    if ((Test-Path $nodeTypesDir) -and (-not (Test-Path $undiciTypesDir))) {
        Write-Host '==> 检测到缺少 undici-types，执行轻量补装 (npm install --no-save undici-types)' -ForegroundColor Yellow
        npm install --no-save undici-types @npmCommonArgs
        if ($LASTEXITCODE -ne 0) { throw "补装 undici-types 失败 (exit $LASTEXITCODE)" }
        Ensure-NodeModulesJunction -NodeModulesDir $nodeModulesDir -SharedNodeModulesDir $sharedNodeModulesDir -EnableShared (-not $disableSharedNodeModules)
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
