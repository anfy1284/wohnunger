@echo off
rem Обновляет пакет my-old-space из GitHub в корне проекта
rem Запускайте этот скрипт из любой папки — он перейдет в корень репозитория

pushd "%~dp0.."
echo --- Updating my-old-space from GitHub (default branch) ---
npm install git+https://github.com/anfy1284/my-old-space.git --save
echo.
echo --- Installed my-old-space info ---
npm ls my-old-space --json
echo.
popd

echo Done.
pause
