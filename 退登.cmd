@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ================================================
echo   豆包退登 / 清理登录信息
echo   会删掉 cookie 文件 和 Edge 配置目录（约 700 MB）
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)
echo.
echo 说明：豆包服务端的退登接口被风控挡死了（实测 2035 非法请求），
echo       所以这里做的是「本地彻底清理」——删干净就等于退登，服务端会话会自然过期。
echo.
node logout.mjs
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo [完成] 已退出登录。想重新登录请双击 登录.cmd) else (echo [未完成] 退出码 %RC%。多半是 Edge 还开着占用了目录，关掉 Edge 再试一次)
pause
exit /b %RC%