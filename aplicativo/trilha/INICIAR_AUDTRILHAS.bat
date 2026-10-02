@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 goto usar_py

where python >nul 2>nul
if not errorlevel 1 goto usar_python

echo.
echo Python 3 nao foi encontrado neste computador.
echo Instale o Python 3.10 ou superior e marque a opcao Add Python to PATH.
echo.
pause
exit /b 1

:usar_py
py -3 aplicativo\servidor.py
goto apos_execucao

:usar_python
python aplicativo\servidor.py

:apos_execucao

if not %errorlevel%==0 (
  echo.
  echo O AudTrilhas foi encerrado com erro. Consulte dados\logs\audtrilhas.log.
  pause
)
endlocal
