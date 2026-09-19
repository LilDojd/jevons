{ pkgs, ... }:
{
  languages = {
    javascript = {
      enable = true;
      package = pkgs.nodejs_24;
      bun.enable = true;
    };
    typescript.enable = true;
  };

  packages = [
    (pkgs.callPackage ./nix/biome.nix { })
    pkgs.jujutsu
    pkgs.nixfmt
    pkgs.secretspec
  ];
}
