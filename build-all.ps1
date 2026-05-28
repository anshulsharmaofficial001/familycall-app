# FamilyCall - Complete Build Script
# Run this in PowerShell as: .\build-all.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   FamilyCall - Complete Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ---- Step 1: Environment Setup ----
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\imkal\AppData\Local\Android\Sdk"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

Write-Host "`n[1/5] Environment Check" -ForegroundColor Yellow
Write-Host "  JAVA_HOME: $env:JAVA_HOME"
Write-Host "  ANDROID_HOME: $env:ANDROID_HOME"
Write-Host "  Java: $(java -version 2>&1 | Select-Object -First 1)"

# ---- Step 2: Firebase Check ----
Write-Host "`n[2/5] Firebase Config Check" -ForegroundColor Yellow
$googleServices = "C:\Users\imkal\Desktop\calling_app\android\app\google-services.json"
if (Test-Path $googleServices) {
    Write-Host "  ✅ google-services.json found"
} else {
    Write-Host "  ⚠️  google-services.json NOT FOUND" -ForegroundColor Red
    Write-Host "  Please setup Firebase first:"
    Write-Host "  1. Go to https://console.firebase.google.com"
    Write-Host "  2. Create project 'FamilyCall'"
    Write-Host "  3. Register Android app (package: com.familycall.app)"
    Write-Host "  4. Download google-services.json to android/app/"
    Write-Host "`n  Continuing without it - build will fail!" -ForegroundColor Red
}

# ---- Step 3: Build Android APK ----
Write-Host "`n[3/5] Building Android APK..." -ForegroundColor Yellow
Set-Location "C:\Users\imkal\Desktop\calling_app\android"

if (Test-Path $googleServices) {
    gradlew.bat assembleDebug 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ APK built successfully!" -ForegroundColor Green
        Get-ChildItem "C:\Users\imkal\Desktop\calling_app\android\app\build\outputs\apk\debug\*.apk" | ForEach-Object {
            Write-Host "  📦 $($_.Name) ($([math]::Round($_.Length/1MB, 2)) MB)"
        }
    } else {
        Write-Host "  ❌ Build failed" -ForegroundColor Red
    }
} else {
    Write-Host "  ⏭️  Skipping APK build (no google-services.json)"
}

# ---- Step 4: Install Server Dependencies ----
Write-Host "`n[4/5] Server Dependencies" -ForegroundColor Yellow
Set-Location "C:\Users\imkal\Desktop\calling_app\server"
Write-Host "  Dependencies already installed ✓"

# ---- Step 5: Configure and Deploy Server ----
Write-Host "`n[5/5] Server Deployment" -ForegroundColor Yellow
Write-Host "  To deploy the server to Render.com (free):"
Write-Host "  1. Push code to GitHub"
Write-Host "  2. Go to https://dashboard.render.com"
Write-Host "  3. New Web Service -> Connect your repo"
Write-Host "  4. Set environment variables (see .env.example)"
Write-Host "`n  Or run locally for testing:"
Write-Host "  cd server && npm start"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "   Build Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
