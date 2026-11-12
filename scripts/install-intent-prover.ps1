param(
  [string]$InstallDir = "$env:LOCALAPPDATA\IntentComputing\IntentProver\bin"
)
$ErrorActionPreference = "Stop"
$BaseUrl = "https://github.com/nlp-research-rosu/intent-prover/releases/download/__INTENT_PROVER_RELEASE_TAG__"

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$asset = switch ($arch) {
  "X64" { "intent-prover-windows-x64.zip" }
  "Arm64" { "intent-prover-windows-arm64.zip" }
  default { throw "Unsupported Windows architecture: $arch" }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$target = Join-Path $InstallDir "intent-prover.exe"
$marker = Join-Path $InstallDir ".intent-prover.sha256"
$existing = Get-Command intent-prover -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing -and ($existing.CommandType -ne "Application" -or
    [IO.Path]::GetFullPath($existing.Source) -ne $target)) {
  throw "Another intent-prover command is on PATH at $($existing.Source)"
}
if (Test-Path $target) {
  if (-not (Test-Path $marker -PathType Leaf) -or
      (Get-Content -Raw $marker).Trim() -ne (Get-FileHash $target -Algorithm SHA256).Hash) {
    throw "Refusing to replace an unrelated executable at $target"
  }
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("intent-prover-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $archive = Join-Path $work $asset
  Invoke-WebRequest "$BaseUrl/$asset" -OutFile $archive
  $checksumFile = Join-Path $work "checksum"
  Invoke-WebRequest "$BaseUrl/$asset.sha256" -OutFile $checksumFile
  $checksum = (Get-Content -Raw $checksumFile).Trim().Split()[0]
  if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $checksum) {
    throw "intent-prover checksum mismatch"
  }
  Expand-Archive $archive -DestinationPath $work
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item (Join-Path $work "intent-prover.exe") $target -Force
  (Get-FileHash $target -Algorithm SHA256).Hash | Set-Content -NoNewline $marker
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
  }
  & $target --version
  Write-Host "Next: run intent-prover health and intent-prover semantics."
  Write-Host "Open a new terminal to use intent-prover"
} finally {
  Remove-Item -Recurse -Force $work
}
