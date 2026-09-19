{
  lib,
  stdenvNoCC,
  fetchurl,
}:
let
  version = "2.5.14";
  # Official native CLI packages; Linux musl binaries need no host dynamic linker.
  artifacts = {
    x86_64-linux = {
      platform = "linux-x64-musl";
      hash = "sha512-2kI5PrMgW5dcEZYrstLPmUmCwkUwZY39rP4BN93Vxbwcs2O57LDQOktUZZYPvvspN5i0mhGr3TJtF5sU26NUWg==";
    };
    aarch64-linux = {
      platform = "linux-arm64-musl";
      hash = "sha512-SJ9PrZkBnnH9dHJDnxk34vKs0GB2dbsioaft6/hPhWJ7AHpwYH83Isnhj0FSRpFkGgpVfJ1lds23ApB2czUDLQ==";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha512-kiy8qA16K93J7uvFfWi4LgjqDpnRKyePAna6A0Y4jxyUga35SYpIZ2cNWlhy0lsfgqRenCpfymnJWEZ6mgpRgA==";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha512-UnzaXO65L4tsZimFITFP2M121GyhDcWFrT3pL5ZJ5U4XcS/0L5VHYytVohdCf/gnDUFHgl2I9xnt5bV/J1kxHQ==";
    };
  };
  artifact = artifacts.${stdenvNoCC.hostPlatform.system};
in
stdenvNoCC.mkDerivation {
  pname = "biome";
  inherit version;
  src = fetchurl {
    url = "https://registry.npmjs.org/@biomejs/cli-${artifact.platform}/-/cli-${artifact.platform}-${version}.tgz";
    inherit (artifact) hash;
  };
  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 biome $out/bin/biome
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    test "$( $out/bin/biome --version )" = "Version: ${version}"
  '';
  meta = {
    description = "Formatter, linter, and import organizer for the web";
    homepage = "https://biomejs.dev";
    license = with lib.licenses; [
      mit
      asl20
    ];
    mainProgram = "biome";
    platforms = builtins.attrNames artifacts;
  };
}
