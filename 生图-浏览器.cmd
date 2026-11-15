@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ================================================
echo   豆包生图 · 方式B 仅浏览器
echo   CDP 驱动 Edge 窗口（会弹出浏览器）
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)
echo 本入口强制方式B：会拉起 Edge 窗口
echo.
node doubao.mjs image --mode browser --interactive
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [完成] 产物在 doubao_out\ 目录) else (echo [失败] 退出码 %RC%，请把上面的报错发给助手排查)
pause
exit /b %RC%
