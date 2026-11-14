<#
.SYNOPSIS
    在 Windows 上注册两个开机自启的计划任务：SearXNG（B2 住宅 IP 通道）与 embedsvc（本地向量服务）。

.DESCRIPTION
    两个任务都使用 AtStartup + SYSTEM，不依赖任何用户登录。
    这样 PC 重启后即使停在锁屏界面，检索链路也能自己起来。

.PARAMETER SearxngDir
    SearXNG 项目目录（包含 searxng_run.py 与 .venv）。
.PARAMETER EmbedsvcDir
    embedsvc 目录（包含 app.py、run_service.py、models/、venv/）。

.EXAMPLE
    .\install-tasks.ps1 -SearxngDir C:\searxng -EmbedsvcDir C:\embedsvc
#>
param(
    [Parameter(Mandatory = $true)][string]$SearxngDir,
    [Parameter(Mandatory = $true)][string]$EmbedsvcDir
)

$ErrorActionPreference = "Stop"

function Install-GatewayTask {
    param(
        [string]$Name,
        [string]$PythonW,
        [string]$Script,
        [string]$WorkDir,
        [string]$Description
    )

    if (-not (Test-Path $PythonW)) { throw "找不到 pythonw.exe: $PythonW" }
    if (-not (Test-Path (Join-Path $WorkDir $Script))) { throw "找不到脚本: $Script" }

    $action = New-ScheduledTaskAction -Execute $PythonW -Argument (Join-Path $WorkDir $Script) -WorkingDirectory $WorkDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description $Description -Force | Out-Null

    Write-Host ("已注册: {0}  (触发=Boot, 账户=SYSTEM)" -f $Name)
}

Write-Host "=== 检查目录 ==="
foreach ($d in @($SearxngDir, $EmbedsvcDir)) {
    if (-not (Test-Path $d)) { throw "目录不存在: $d" }
    Write-Host ("  OK: {0}" -f $d)
}

Install-GatewayTask `
    -Name "SearXNG-B2" `
    -PythonW (Join-Path $SearxngDir ".venv\Scripts\pythonw.exe") `
    -Script "searxng_run.py" `
    -WorkDir $SearxngDir `
    -Description "SearXNG 127.0.0.1:8890，开机即起，不依赖用户登录"

Install-GatewayTask `
    -Name "Embedsvc-PC" `
    -PythonW (Join-Path $EmbedsvcDir "venv\Scripts\pythonw.exe") `
    -Script "run_service.py" `
    -WorkDir $EmbedsvcDir `
    -Description "本地向量服务 127.0.0.1:8091，开机即起，不依赖用户登录"

Write-Host ""
Write-Host "=== 立即启动 ==="
foreach ($t in @("SearXNG-B2", "Embedsvc-PC")) {
    Start-ScheduledTask -TaskName $t
    Write-Host ("  已启动: {0}" -f $t)
}

Write-Host ""
Write-Host "=== 等待端口就绪（最多 40 秒）==="
$deadline = (Get-Date).AddSeconds(40)
foreach ($port in @(8890, 8091)) {
    while ((Get-Date) -lt $deadline) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            Write-Host ("  {0} 已监听" -f $port)
            break
        }
        Start-Sleep -Seconds 2
    }
}

Write-Host ""
Write-Host "完成。验证："
Write-Host '  Invoke-RestMethod http://127.0.0.1:8091/health'
Write-Host '  Invoke-RestMethod "http://127.0.0.1:8890/search?q=test&format=json"'
