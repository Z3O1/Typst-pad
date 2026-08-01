@echo off
rem Install VS Build Tools 2022 with C++ desktop workload (required by Tauri/MSVC)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
echo ExitCode=%ERRORLEVEL%
