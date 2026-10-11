{
  description = "Kir-Dev Kubernetes development environment";

  # We only depend on a version of Nixpkgs
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # Output a dev shell per system
  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        # This flake can be used on: Linux x86_64 and MacOS Intel + Apple Silicon
        "x86_64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      # Output a dev shell for each supported system
      devShells = forAllSystems (system: {
        default =
          let
            pkgs = nixpkgs.legacyPackages.${system};
          in
          # Make a shell that has these packages available
          pkgs.mkShell {
            packages = [
              pkgs.bun # JavaScript runtime and package manager
              pkgs.k3d # Local dev Kubernetes clusters
              pkgs.kubectl # Kubernetes CLI
              pkgs.kubelogin-oidc # OIDC login for kubectl, usage: `kubectl oidc-login`
              pkgs.kubernetes-helm # Kubernetes package manager
              pkgs.vcluster # Virtual Kubernetes clusters
            ];

            # Add a [dev-shell] prefix to the shell prompt
            shellHook = ''
              export PS1="\[\e[1;34m\][dev-shell]\[\e[0m\] $PS1"
            '';
          };
      });

      # Set the Nix formatter, usage: `nix develop`, then `nix fmt flake.nix`
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
