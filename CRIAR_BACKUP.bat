@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 goto usar_py

where python >nul 2>nul
if not errorlevel 1 goto usar_python

echo Python 3 nao foi encontrado neste computador.
goto fim

:usar_py
py -3 aplicativo\backup.py
goto fim

:usar_python
python aplicativo\backup.py

:fim
echo.
pause
endlocal
