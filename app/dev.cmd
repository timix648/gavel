@echo off
cd /d "%~dp0"
if exist node_modules\.vite rmdir /s /q node_modules\.vite
"C:\Program Files\nodejs\node.exe" node_modules\vite\bin\vite.js --port 5173 --strictPort
