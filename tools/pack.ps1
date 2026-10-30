# 打包给 Linux 服务器（Windows 侧）：排除 data/、缓存和启动器
# 用法：powershell -ExecutionPolicy Bypass -File tools\pack.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # 项目根
$name = Split-Path -Leaf $root                     # agy-bridge
$parent = Split-Path -Parent $root
$out = Join-Path $parent "$name.tar.gz"

if (Test-Path $out) { Remove-Item $out -Force }

Push-Location $parent
try {
    tar -czf $out `
        --exclude="$name/data" `
        --exclude="$name/node_modules" `
        --exclude="$name/__pycache__" `
        --exclude="$name/script/__pycache__" `
        --exclude="$name/script/launcher.py" `
        --exclude="$name/.git" `
        $name
    if ($LASTEXITCODE -ne 0) { throw "tar 打包失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "打包完成：$out  ($size MB)" -ForegroundColor Green
Write-Host ""
Write-Host "上传：  scp `"$out`" user@server:/opt/" -ForegroundColor DarkGray
Write-Host "解包：  ssh user@server 'cd /opt && tar -xzf $name.tar.gz && cd $name && chmod +x script/run.sh && ./script/run.sh'" -ForegroundColor DarkGray
