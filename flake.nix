{
  # quartermaster para Nix.
  #
  # Mismo trato que el .deb y el PKGBUILD: no compila nada. qm lee el
  # TypeScript directo, así que el paquete son los fuentes más un lanzador — y
  # acá el lanzador queda envuelto con el Node correcto, que es la parte que en
  # las otras plataformas hace bin/qm buscando en el PATH y en nvm.
  #
  # En Nix eso no hace falta: el Node es una dependencia del cierre y está en
  # una ruta fija. Por eso el wrapper pone ese Node ADELANTE del PATH — así
  # `sirve()` de bin/qm encuentra primero el que corresponde y no el que el
  # usuario tenga instalado, que puede ser un 20.
  #
  #   nix run  github:legiosai/quartermaster          # ver la cuota, ya
  #   nix shell github:legiosai/quartermaster         # qm en el shell
  #   nix profile install github:legiosai/quartermaster

  description = "Cuánta cuota te queda, en todas tus cuentas de agentes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # 22.6 es el piso real: antes no hay type stripping y tampoco
        # node:sqlite, que usa el adaptador de opencode.
        node = pkgs.nodejs_22;
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        quartermaster = pkgs.stdenv.mkDerivation {
          pname = "quartermaster";
          inherit version;
          src = ./.;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          dontBuild = true;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/quartermaster
            cp -r bin src scripts package.json $out/lib/quartermaster/

            # Nada de Windows adentro de un cierre de Nix.
            rm -f $out/lib/quartermaster/bin/*.cmd \
                  $out/lib/quartermaster/bin/qm-tray.ps1 \
                  $out/lib/quartermaster/bin/quartermaster.ico
            find $out/lib/quartermaster -name '__pycache__' -prune -exec rm -rf {} + || true

            mkdir -p $out/bin
            for cada in qm qm-web; do
              makeWrapper $out/lib/quartermaster/bin/$cada $out/bin/$cada \
                --prefix PATH : ${node}/bin
            done

            install -Dm644 LICENSE $out/share/licenses/quartermaster/LICENSE
            install -Dm644 README.md $out/share/doc/quartermaster/README.md

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Cuánta cuota te queda en todos los perfiles de Claude Code de la máquina, más Codex y opencode";
            homepage = "https://quartermaster.legios.com.ar/";
            license = licenses.mit;
            platforms = platforms.unix;
            mainProgram = "qm";
          };
        };
      in
      {
        packages.default = quartermaster;
        packages.quartermaster = quartermaster;

        apps.default = {
          type = "app";
          program = "${quartermaster}/bin/qm";
        };

        devShells.default = pkgs.mkShell {
          packages = [ node pkgs.gnumake ];
        };
      });
}
