 @echo off
 cd /d "%~dp0"
 title 报销自动化系统
 
 echo.
 echo [1/3] 检查环境...
 if not exist .env (
   copy .env.example .env >nul 2>&1
   echo   .env 文件已从 .env.example 创建，请编辑填入账号密码。
   echo.
   echo   请编辑 .env 文件，填入以下内容：
   echo   - BIP_USERNAME=你的BIP账号
   echo   - BIP_PASSWORD=你的BIP密码
   echo.
   pause
   exit /b 1
 )
 
 echo.
 echo [2/3] 检查依赖...
 
 echo.
 echo [2/3] 检查依赖...
 if not exist "node_modules" (
   echo   正在安装 Node.js 依赖...
   call npm.cmd install
   if %errorlevel% neq 0 (
     echo   依赖安装失败
     pause
     exit /b 1
   )
 )
 
 echo.
 echo [3/3] 启动服务...
 echo.
 echo   =======================================
 echo    报销自动化系统
 echo    启动后请访问:
 echo    http://localhost:8080
 echo   =======================================
 echo.
 npx.cmd tsx src/server.ts
 
 pause
