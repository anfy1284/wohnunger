@echo off
setlocal

set "SRC=D:\wohnunger\node_modules\my-old-space"
set "DEST=E:\Andrey\my-old-space"

xcopy "%SRC%" "%DEST%" /E /I /Y /H /C /Q

endlocal
