@echo off
setlocal
set "APP_EXE=%~dp0..\..\cjh.exe"
set "CLI_JS=%~dp0..\app.asar\out\main\cli.js"
if exist "%APP_EXE%" (
  set ELECTRON_RUN_AS_NODE=1
  "%APP_EXE%" "%CLI_JS%" %*
) else (
  node "%~dp0..\..\out\main\cli.js" %*
)
