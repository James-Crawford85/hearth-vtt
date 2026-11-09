@echo off
rem ---------------------------------------------------------------------------
rem  Hearth release helper
rem
rem  Asks for a version, sets it in Cargo.toml and tauri.conf.json, commits,
rem  tags vX.Y.Z and pushes. GitHub Actions then builds installers for every
rem  platform into a DRAFT release; publish it on GitHub when you're happy.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
set "REPO_URL=https://github.com/James-Crawford85/hearth-vtt"

echo.
echo  Hearth release
echo  ==============
echo.

rem --- tools ------------------------------------------------------------------
where git >nul 2>&1 || (echo  git was not found on PATH.& goto :fail)
where cargo >nul 2>&1 || (echo  cargo was not found on PATH.& goto :fail)

rem --- must be on main, clean, and up to date ----------------------------------
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
if /i not "%BRANCH%"=="main" (
  echo  You are on branch "%BRANCH%". Switch to main first:  git switch main
  goto :fail
)

set "DIRTY="
for /f "delims=" %%x in ('git status --porcelain') do set "DIRTY=1"
if defined DIRTY (
  echo  You have uncommitted changes. Commit or stash them first:
  git status --short
  goto :fail
)

echo  Checking GitHub for newer commits...
git fetch --quiet origin || (echo  Could not reach GitHub.& goto :fail)
for /f %%n in ('git rev-list --count HEAD..origin/main') do set "BEHIND=%%n"
if not "%BEHIND%"=="0" (
  echo  GitHub has %BEHIND% commit^(s^) you don't have. Run:  git pull
  goto :fail
)

rem --- ask for the version -------------------------------------------------------
for /f "delims=" %%v in ('powershell -NoProfile -ExecutionPolicy Bypass -File tools\set-version.ps1') do set "CURRENT=%%v"
echo  Current version: %CURRENT%
echo.
set "VER="
set /p "VER=  New version (e.g. 0.2.0): "
if not defined VER (echo  No version entered.& goto :fail)
rem Accept "v0.2.0" too.
if /i "%VER:~0,1%"=="v" set "VER=%VER:~1%"

echo %VER%| findstr /r /x "[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (echo  "%VER%" isn't a version like 1.2.3.& goto :fail)

set "TAG=v%VER%"
git rev-parse -q --verify "refs/tags/%TAG%" >nul 2>&1 && (echo  Tag %TAG% already exists locally.& goto :fail)
set "REMOTE_TAG="
for /f "delims=" %%t in ('git ls-remote --tags origin "refs/tags/%TAG%"') do set "REMOTE_TAG=1"
if defined REMOTE_TAG (echo  Tag %TAG% already exists on GitHub.& goto :fail)

echo.
echo  This will:
echo    1. set the version to %VER%
echo    2. commit "Release %TAG%" and tag it %TAG%
echo    3. push to GitHub, which builds a draft release
echo.
choice /c YN /n /m "  Continue? [Y/N] "
if errorlevel 2 (echo  Cancelled. Nothing was changed.& goto :end)

rem --- bump, commit, tag, push -------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File tools\set-version.ps1 %VER% || goto :fail
echo  Updating Cargo.lock...
cargo update --workspace --quiet || goto :undo

git add Cargo.toml Cargo.lock crates/hearth-desktop/tauri.conf.json || goto :undo
git diff --cached --quiet
if errorlevel 1 (
  git commit --quiet -m "Release %TAG%" || goto :undo
  echo  Committed "Release %TAG%".
) else (
  echo  Version was already %VER%; tagging the current commit.
)
git tag -a "%TAG%" -m "Hearth %TAG%" || goto :fail

echo  Pushing to GitHub...
git push --quiet origin main || (echo  Push of main failed. Your commit and tag are still here; fix the problem and run:& echo    git push origin main ^&^& git push origin %TAG%& goto :fail)
git push --quiet origin "%TAG%" || (echo  Push of the tag failed. Run:  git push origin %TAG%& goto :fail)

echo.
echo  Done! GitHub is now building %TAG% (about 15-20 minutes).
echo    Progress:  %REPO_URL%/actions
echo    Release:   %REPO_URL%/releases   (publish the draft when it's ready)
echo.
choice /c YN /n /m "  Open the build progress page now? [Y/N] "
if not errorlevel 2 start "" "%REPO_URL%/actions"
goto :end

:undo
echo  Something failed before committing; putting the version files back.
git checkout -- Cargo.toml Cargo.lock crates/hearth-desktop/tauri.conf.json >nul 2>&1
git reset --quiet >nul 2>&1

:fail
echo.
echo  Release NOT completed.
echo.
pause
endlocal
exit /b 1

:end
echo.
pause
endlocal
exit /b 0
