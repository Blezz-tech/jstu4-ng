# NixOS development shell for jstu4 (Node.js, Vite, Vitest, Playwright).
#
# Uses your system nixpkgs (e.g. nixos-unstable) via <nixpkgs> or the system
# flake registry, without pinning a separate nixpkgs snapshot:
#   nix-shell
#   nix-shell --run "npm ci && npm run check && npm run test:e2e"
#   nix develop --impure -f shell.nix
#
# Reference: https://wiki.nixos.org/wiki/Playwright
{
  pkgs ?
    let
      systemNixpkgs = builtins.tryEval <nixpkgs>;
    in
    if systemNixpkgs.success then
      import systemNixpkgs.value { }
    else
      (builtins.getFlake "nixpkgs").legacyPackages.${builtins.currentSystem}
}:

let
  # Matches package.json engines ("^20.19.0 || ^22.12.0 || >=24.0.0").
  nodejs = pkgs.nodejs_24 or pkgs.nodejs_22 or pkgs.nodejs;
  browsers = pkgs.playwright-driver.browsers;
  nixPlaywrightVersion = pkgs.playwright-driver.version or "unknown";
in
pkgs.mkShell {
  name = "jstu4-dev";

  packages = [
    nodejs
    browsers
  ];

  PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  PLAYWRIGHT_NODEJS_PATH = "${nodejs}/bin/node";

  shellHook = ''
    # Point Playwright directly at the Nix-packaged Chromium executable so e2e
    # tests keep working even when nixos-unstable's playwright-driver revision
    # differs from @playwright/test in package-lock.json.
    chromium_bin=""
    for candidate in \
      "${browsers}"/chromium-*/chrome-linux64/chrome \
      "${browsers}"/chromium-*/chrome-linux/chrome \
      "${browsers}"/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium; do
      if [ -x "$candidate" ]; then
        chromium_bin="$candidate"
        break
      fi
    done
    if [ -n "$chromium_bin" ]; then
      export PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH="$chromium_bin"
    fi

    npm_pw_version=""
    if [ -f node_modules/@playwright/test/package.json ]; then
      npm_pw_version="$(node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null || true)"
    fi

    echo "jstu4 NixOS shell (Node $(node -v))"
    echo "  PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"
    if [ -n "$chromium_bin" ]; then
      echo "  PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH=$chromium_bin"
    fi
    if [ -n "$npm_pw_version" ]; then
      if [ "${nixPlaywrightVersion}" = "$npm_pw_version" ]; then
        echo "  Playwright: nix ${nixPlaywrightVersion} == npm $npm_pw_version"
      else
        echo "  Playwright: nix ${nixPlaywrightVersion} != npm $npm_pw_version (using Nix Chromium executable)"
      fi
    else
      echo "  Playwright (nix): ${nixPlaywrightVersion} (run 'npm ci' to install JS dependencies)"
    fi
  '';
}
