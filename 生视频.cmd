@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ================================================
echo   豆包生视频
echo   自动：先试直连（无需浏览器），失败自动切浏览器
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)
echo 方式A 直连优先 → 失败自动降级方式B（浏览器）
echo.
node doubao.mjs video --mode auto --interactive
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [完成] 产物在 doubao_out\ 目录) else (echo [失败] 退出码 %RC%，请把上面的报错发给助手排查)
pause
exit /b %RC%
