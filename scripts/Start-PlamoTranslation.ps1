param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\.runtime'),
  [int]$Port = 18080
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeDirectory)
$healthUrl = "http://127.0.0.1:$Port/health"
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  if ($health.status -eq 'ok') {
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 2
    if ($models.data.id -notcontains 'plamo-3-translate-0.8b') { throw "Port $Port belongs to another model" }
    Write-Output "PLaMo translation API ready on 127.0.0.1:$Port"
    return
  }
} catch {
  if ($_.Exception.Message -like '*belongs to another model*') { throw }
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is in use and PLaMo is not ready"
}
$serverExe = Join-Path $runtimeRoot 'bin\llama-server.exe'
$modelFile = Join-Path $runtimeRoot 'models\plamo-3-translate-0.8b-Q4_K_M.gguf'
$templateFile = Join-Path $runtimeRoot 'models\chat_template.jinja'
foreach ($file in @($serverExe, $modelFile, $templateFile)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Missing required file. Run python scripts/setup.py, or disable autoStart to use an existing API." }
}
$logs = Join-Path $runtimeRoot 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$threads = [Math]::Max(1, [Math]::Min(8, [Environment]::ProcessorCount - 2))
$serverArgs = @(
  '--model', "`"$modelFile`"", '--alias', 'plamo-3-translate-0.8b',
  '--host', '127.0.0.1', '--port', "$Port",
  '--ctx-size', '8192', '--parallel', '2',
  '--threads', "$threads", '--threads-batch', "$threads",
  '--n-gpu-layers', '99', '--flash-attn', 'on',
  '--chat-template-file', "`"$templateFile`"", '--jinja', '--no-prefill-assistant',
  '--no-webui', '--no-warmup'
)
$process = Start-Process -FilePath $serverExe -ArgumentList $serverArgs -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'llama.stdout.log') -RedirectStandardError (Join-Path $logs 'llama.stderr.log')
[IO.File]::WriteAllText((Join-Path $runtimeRoot 'llama.pid'), "$($process.Id)`n", [Text.UTF8Encoding]::new($false))
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  if ($process.HasExited) { throw "PLaMo exited with $($process.ExitCode); see .runtime/logs/llama.stderr.log" }
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.status -eq 'ok') {
      Write-Output "PLaMo translation API ready on 127.0.0.1:$Port"
      return
    }
  } catch {}
  Start-Sleep -Seconds 1
}
throw 'PLaMo startup timed out; see .runtime/logs/llama.stderr.log'
