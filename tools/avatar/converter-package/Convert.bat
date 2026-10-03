@echo off
rem Scale avatar converter: drop character files (and optional animation files) onto this.
rem First run downloads Blender (portable, ~350 MB) from blender.org into this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert.ps1" %*
