@echo off
curl -s -o NUL -w "vite HTTP %{http_code}" http://127.0.0.1:1420/
echo.
tasklist /NH | findstr /i "tauri-app.exe"
if %ERRORLEVEL% EQU 0 (echo APP_PROCESS_OK) else (echo APP_PROCESS_NOT_FOUND)
