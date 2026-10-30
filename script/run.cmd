@echo off
chcp 65001 >nul
title AGY Bridge
cd /d "%~dp0.."

rem Windows 双击入口：找到 Python，交给 start.py
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo   没找到 Python。装一个 3.8 以上的版本再双击本文件。
  echo   下载地址：https://www.python.org/downloads/windows/
  echo.
  pause
  exit /b 1
)

%PY% "%~dp0start.py" %*
set RC=%errorlevel%
if not "%RC%"=="0" (
  echo.
  echo   启动器退出，代码 %RC%
  pause
)
