@echo off
setlocal

set "SRC=D:\prj\wonunger\node_modules\my-old-space"
set "DEST=D:\prj\my-old-space"

xcopy "%SRC%" "%DEST%" /E /I /Y /H /C /Q

endlocal
