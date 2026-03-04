@echo off
setlocal

set "SRC=E:\Andrey\old-space-app\node_modules\my-old-space"
set "DEST=E:\Andrey\my-old-space"

xcopy "%SRC%" "%DEST%" /E /I /Y /H /C /Q

endlocal
