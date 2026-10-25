@echo off
rem CxMissionZero activation codes (Windows cmd). Signs codes with YOUR private key, issuer-key.pem.
rem The key stays on this PC: each command mounts its folder read-only into a throwaway container
rem (podman run --rm) that runs scripts/activation.mjs from the CxMissionZero image, prints the code and is removed.
rem Never commit issuer-key.pem, never put it in the image, never email it.
rem
rem Usage:  activation-codes.cmd <what> ["<organisation>"] [months or date]
rem   keygen                 make a NEW key pair (once; refuses to overwrite) and print the public key
rem   product <YYYY-MM-DD|months>   the product code for everyone: CxMissionZero works until then
rem   tenants "<org>" <max> [months]   several Checkmarx One tenants, up to <max>
rem   hebrew-on "<org>" [months]     Hebrew on          hebrew-off "<org>"   Hebrew off
rem   impact-on "<org>" [months]     calculator Impact tab on   impact-off "<org>"   off
rem   fae-on "<org>" [months]        FAE Flush (Labs) on (MZ-01.00.95 or later)   fae-off "<org>"   off
rem   govern-on "<org>" [months]     Govern (Labs) on (MZ-01.01.00 or later)   govern-off "<org>"   off
rem   status-on "<org>" [months]     Status board (Labs) on (MZ-01.01.00 or later)   status-off "<org>"   off
rem   consolidated-on "<org>" [months]   Consolidated view (Labs) on (MZ-01.01.00 or later)   consolidated-off "<org>"   off
rem   show <code>                    what a code contains
rem Codes last 12 months unless a number of months is given. Example:  activation-codes.cmd fae-on "Acme Corp" 6

setlocal
rem ---- Change these two lines once ----
set "KEYDIR=%USERPROFILE%\mz-keys"
set "IMAGE=ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest"
set "RUN=podman run --rm -v "%KEYDIR%:/keys:ro" %IMAGE% node scripts/activation.mjs"
set "MONTHS=%~3"
if "%MONTHS%"=="" set "MONTHS=12"

if /i "%~1"=="keygen" goto keygen
if not exist "%KEYDIR%\issuer-key.pem" if /i not "%~1"=="show" (echo No key at %KEYDIR%\issuer-key.pem: set KEYDIR at the top of this file. & exit /b 1)
if /i "%~1"=="product" %RUN% product /keys/issuer-key.pem %2 & goto end
if /i "%~1"=="tenants" %RUN% issue /keys/issuer-key.pem "%~2" %3 %4 & goto end
if /i "%~1"=="hebrew-on" %RUN% lang /keys/issuer-key.pem "%~2" he on %MONTHS% & goto end
if /i "%~1"=="hebrew-off" %RUN% lang /keys/issuer-key.pem "%~2" he off & goto end
if /i "%~1"=="impact-on" %RUN% feature /keys/issuer-key.pem "%~2" impact on %MONTHS% & goto end
if /i "%~1"=="impact-off" %RUN% feature /keys/issuer-key.pem "%~2" impact off & goto end
if /i "%~1"=="fae-on" %RUN% feature /keys/issuer-key.pem "%~2" faeFlush on %MONTHS% & goto end
if /i "%~1"=="fae-off" %RUN% feature /keys/issuer-key.pem "%~2" faeFlush off & goto end
if /i "%~1"=="govern-on" %RUN% feature /keys/issuer-key.pem "%~2" govern on %MONTHS% & goto end
if /i "%~1"=="govern-off" %RUN% feature /keys/issuer-key.pem "%~2" govern off & goto end
if /i "%~1"=="status-on" %RUN% feature /keys/issuer-key.pem "%~2" statusBoard on %MONTHS% & goto end
if /i "%~1"=="status-off" %RUN% feature /keys/issuer-key.pem "%~2" statusBoard off & goto end
if /i "%~1"=="consolidated-on" %RUN% feature /keys/issuer-key.pem "%~2" consolidated on %MONTHS% & goto end
if /i "%~1"=="consolidated-off" %RUN% feature /keys/issuer-key.pem "%~2" consolidated off & goto end
if /i "%~1"=="show" podman run --rm %IMAGE% node scripts/activation.mjs show %2 & goto end
echo Unknown: "%~1". Open this file for the list. & exit /b 2

:keygen
if exist "%KEYDIR%\issuer-key.pem" (echo %KEYDIR%\issuer-key.pem already exists: not making another. & exit /b 1)
if not exist "%KEYDIR%" mkdir "%KEYDIR%"
podman run --rm -v "%KEYDIR%:/keys" %IMAGE% node scripts/activation.mjs keygen /keys/issuer-key.pem
echo The public key above goes into ISSUER_KEYS in src/activation.js (only if you are replacing the key).

:end
endlocal
