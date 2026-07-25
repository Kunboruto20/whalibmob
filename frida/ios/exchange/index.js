// Trace the plaintext passed to mbedtls_gcm_update inside the iOS client.
//
// Ported into whalibmob from Auties00/Cobalt
// (tools/mobile/ios/frida-scripts/exchange/index.js), MIT licensed,
// Copyright (c) 2021 Alessandro Autiero. Reference-only reverse-engineering aid.

Interceptor.attach(Module.getExportByName("SharedModules", "mbedtls_gcm_update"), {
    onEnter(args) {
        console.log("[*] Called mbedtls_gcm_update", Memory.readUtf8String(args[2], args[1].toInt32()))
    }
})