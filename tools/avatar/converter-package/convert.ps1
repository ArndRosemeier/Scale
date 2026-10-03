# Scale avatar converter (Windows). Converts FBX / .blend / glTF / OBJ / DAE characters into
# a GLB for the game's "Import model" button, using a portable Blender that is downloaded
# from blender.org on first use (checksum-verified) and kept next to this script.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = '4.5.12'
$Zip = "blender-$Version-windows-x64.zip"
$Sha = '317ef64e7a2c3cc79ec810c766ae9828aff865bea78039dc695b3f1118c34b4f'
$Url = "https://download.blender.org/release/Blender4.5/$Zip"
$Home_ = Join-Path $here 'blender'
$Exe = Join-Path $Home_ "blender-$Version-windows-x64\blender.exe"

function Pause-Exit($code) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null; exit $code }

if ($env:BLENDER_BIN -and (Test-Path $env:BLENDER_BIN)) { $Exe = $env:BLENDER_BIN }
if (-not (Test-Path $Exe)) {
  Write-Host "First run: downloading Blender $Version (portable, about 350 MB) from blender.org ..."
  $tmp = Join-Path $env:TEMP $Zip
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UserAgent 'scale-avatar-converter/1.0'
  } catch { Write-Host "Download failed: $($_.Exception.Message)"; Pause-Exit 1 }
  Write-Host 'Verifying checksum ...'
  $h = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
  if ($h -ne $Sha) { Remove-Item $tmp -Force; Write-Host "Checksum mismatch ($h) - download corrupted or tampered. Aborting."; Pause-Exit 1 }
  Write-Host 'Unpacking ...'
  New-Item -ItemType Directory -Force $Home_ | Out-Null
  tar -xf $tmp -C $Home_
  if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $tmp -DestinationPath $Home_ -Force }
  Remove-Item $tmp -Force
  if (-not (Test-Path $Exe)) { Write-Host 'Blender could not be installed.'; Pause-Exit 1 }
  Write-Host 'Blender is ready.'
}

if (-not $Files -or $Files.Count -eq 0) {
  Write-Host 'Drop a character file onto Convert.bat (FBX, .blend, glTF/GLB, OBJ, DAE).'
  Write-Host 'Extra files dropped together are treated as animations for the same rig'
  Write-Host '(e.g. Mixamo: character.fbx + Idle.fbx + Walking.fbx).'
  Pause-Exit 0
}
# Explorer does not keep the drop order: the largest file is the character (it has the
# mesh), the others are animations for the same rig.
$sorted = @($Files | Sort-Object { (Get-Item -LiteralPath $_).Length } -Descending)
$model = $sorted[0]
$Files = $sorted
$out = [IO.Path]::Combine([IO.Path]::GetDirectoryName($model), [IO.Path]::GetFileNameWithoutExtension($model) + '.glb')
if ($out -eq $model) { $out = [IO.Path]::Combine([IO.Path]::GetDirectoryName($model), [IO.Path]::GetFileNameWithoutExtension($model) + '_scale.glb') }
Write-Host "Converting $([IO.Path]::GetFileName($model)) ..."
$log = & $Exe -b --factory-startup -P (Join-Path $here 'convert_avatar.py') -- $out @Files 2>&1
$log | Where-Object { $_ -match '\[avatar\]|Error|Traceback' } | ForEach-Object { Write-Host $_ }
if (-not (Test-Path $out)) { Write-Host ''; Write-Host 'Conversion failed. Full log:'; $log | Select-Object -Last 40 | ForEach-Object { Write-Host $_ }; Pause-Exit 1 }
Write-Host ''
Write-Host "Done: $out"
Write-Host 'Import it in the game: start screen -> "Import model..." (or drag the .glb onto the start screen).'
Pause-Exit 0
