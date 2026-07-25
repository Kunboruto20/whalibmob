// Print registration public key
//
// Ported into whalibmob from Auties00/Cobalt
// (tools/mobile/ios/frida-scripts/registration/registration.js), MIT licensed,
// Copyright (c) 2021 Alessandro Autiero.
//
// Hooks -[WAECAgreement calculateAgreementFromPublicKey:privateKey:] and prints
// the Curve25519 registration public key the native iOS client generates, so it
// can be reused as the `authkey` in whalibmob's registration payload.

Interceptor.attach(ObjC.classes.WAECAgreement["+ calculateAgreementFromPublicKey:privateKey:"].implementation, {
   onEnter(args) {
      console.log("[*] Registration Public key:", arrayBufferToHex(ObjC.Object(args[2])["- key"]().bytes().readByteArray(32)))
   }
})

function arrayBufferToHex(arrayBuffer) {
  const byteArray = new Uint8Array(arrayBuffer);
  let hexString = '';
  for (let i = 0; i < byteArray.length; i++) {
    const hex = byteArray[i].toString(16);
    hexString += (hex.length === 1 ? '0' : '') + hex;
  }
  return hexString;
}
