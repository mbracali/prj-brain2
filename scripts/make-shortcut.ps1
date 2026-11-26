# Windows: create BRAIN2.lnk next to BRAIN2.bat, with the BRAIN2 icon.
# Pin it to the taskbar or Start, or copy it to the desktop. BRAIN2.bat runs this on first launch.
#   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1 [-Desktop]
param([switch]$Desktop)
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "BRAIN2.bat"
$icon = Join-Path $root "res\brain2-icon.ico"
$places = @(Join-Path $root "BRAIN2.lnk")
if ($Desktop) { $places += Join-Path ([Environment]::GetFolderPath("Desktop")) "BRAIN2.lnk" }
$shell = New-Object -ComObject WScript.Shell
foreach ($path in $places) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.WindowStyle = 7 # start minimized: only the BRAIN2 window shows up
  $lnk.Description = "BRAIN2 - Personal Assistant Harness"
  $lnk.Save()
  Write-Output "Created $path"
}
