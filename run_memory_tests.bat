@echo off
echo ========================================
echo  StatusForge Memory Leak Tests
echo ========================================
echo.

C:\Users\OddTower\AppData\Local\Programs\Python\Python312\python.exe -m pytest tests/test_memory_leak.py -v --tb=short -m memory

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [FAIL] Memory leak tests failed!
    exit /b 1
) else (
    echo.
    echo [PASS] All memory leak tests passed.
    exit /b 0
)
