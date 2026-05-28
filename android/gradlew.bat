@echo off
setlocal
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set ANDROID_HOME=C:\Users\imkal\AppData\Local\Android\Sdk
set GRADLE_HOME=C:\Users\imkal\.gradle\wrapper\dists\gradle-8.9-bin\90cnw93cvbtalezasaz0blq0a\gradle-8.9
"%GRADLE_HOME%\bin\gradle.bat" %*
