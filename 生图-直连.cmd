@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ================================================
echo   豆包生图 · 方式A 仅直连
echo   纯 HTTP，绝不启动浏览器
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)
echo 本入口强制方式A：不会拉起 Edge
echo.
node doubao.mjs image --mode direct --interactive
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [完成] 产物在 doubao_out\ 目录) else (echo [失败] 退出码 %RC%，请把上面的报错发给助手排查)
pause
exit /b %RC%
