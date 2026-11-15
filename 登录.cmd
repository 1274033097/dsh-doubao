@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ================================================
echo   豆包扫码登录
echo   （用屏幕外的 Edge 打开真实登录页，不会弹窗打扰你）
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)
echo.
echo 二维码会在看图窗口自动弹出；过期了脚本会自动重截一张新的
echo 用「豆包 APP」或「抖音 APP」扫码，并在手机上点「确认登录」
echo.
node login.mjs --timeout 300 --open
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [成功] 登录态已保存，之后可直接双击 生图.cmd / 生视频.cmd) else (echo [未完成] 退出码 %RC%。若反复失败，可改用：node login.mjs --mode http)
pause
exit /b %RC%
