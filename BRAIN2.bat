@echo off
rem Windows: double-click to launch the latest BRAIN2 from this folder.
rem Installs missing dependencies, rebuilds the UI, then starts the app.
setlocal
set "ROOT=%~dp0"

where node >nul 2>nul || (echo [brain2] Node.js is required: https://nodejs.org & pause & exit /b 1)

if not exist "%ROOT%backend\.venv\Scripts\python.exe" (
  echo [brain2] Installing backend dependencies...
  pushd "%ROOT%backend"
  where uv >nul 2>nul && (
    uv venv -q .venv && uv pip install -q --python .venv -e ".[dev]"
  ) || (
    python -m venv .venv && .venv\Scripts\pip install -q -e ".[dev]"
  )
  popd
)

if not exist "%ROOT%app\node_modules" (
  echo [brain2] Installing app dependencies...
  pushd "%ROOT%app" && call npm install --no-audit --no-fund --silent && popd
)

rem A shortcut with the BRAIN2 icon (pin it to the taskbar / Start or copy it to the desktop).
if not exist "%ROOT%BRAIN2.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\make-shortcut.ps1" >nul 2>nul && echo [brain2] Created BRAIN2.lnk ^(pin it to the taskbar to launch BRAIN2 with its icon^).
)

echo [brain2] Building the UI...
pushd "%ROOT%app"
call npm run build --silent || (echo [brain2] UI build failed. & pause & exit /b 1)
start "" npx electron .
popd
endlocal
