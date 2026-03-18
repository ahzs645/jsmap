class UnsupportedIsolate {
  constructor() {
    throw new Error(
      'isolated-vm is stubbed in this repo. The Node snapshot processor uses webcrack with deobfuscate=false, so the native sandbox is intentionally unavailable.',
    );
  }
}

module.exports = {
  Isolate: UnsupportedIsolate,
};
