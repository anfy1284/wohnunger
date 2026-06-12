@echo off
rem Полностью перезагружает прикладной проект из GitHub
rem ВНИМАНИЕ: удаляет все локальные изменения и неотслеживаемые файлы

pushd "%~dp0.."
echo --- Fetching latest changes from GitHub ---
git fetch origin

echo.
echo --- Resetting working tree to origin/master ---
git reset --hard origin/master

echo.
echo --- Removing untracked files and folders ---
git clean -fd

echo.
echo --- Current status ---
git status --short --branch

echo.
popd

echo Done.
pause
