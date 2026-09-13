@echo off
setlocal

set "SRC=D:\wohnunger\node_modules\my-old-space"
set "DEST=E:\Andrey\my-old-space"

rem Полная очистка приёмника, кроме .git и .gitignore — иначе снесём сам репозиторий.
for /d %%D in ("%DEST%\*") do if /i not "%%~nxD"==".git" rd /s /q "%%D"
for %%F in ("%DEST%\*") do if /i not "%%~nxF"==".gitignore" del /f /q "%%F"

xcopy "%SRC%" "%DEST%" /E /I /Y /H /C /Q

endlocal
