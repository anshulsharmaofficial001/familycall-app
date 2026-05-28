If you have issues downloading WebRTC dependency from Maven,
download the AAR manually from:
https://repo1.maven.org/maven2/io/getstream/stream-webrtc-android/

Place the AAR file here and update build.gradle.kts to use:
implementation(files("libs/stream-webrtc-android-x.y.z.aar"))
