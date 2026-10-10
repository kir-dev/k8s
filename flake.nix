{
  description = "Kir-Dev Kubernetes configuration development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun # Fast JavaScript package manager and runtime
            k3d # Simple tool for creating k3s-based Kubernetes cluster
            kubectl # Kubernetes CLI
            kubernetes-helm # Kubernetes package manager
            vcluster # Virtual Kubernetes clusters
          ];
        };

        # Nix formatter, use with `nix fmt`
        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
