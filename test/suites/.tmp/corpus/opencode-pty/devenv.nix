{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

let
  browsers =
    (builtins.fromJSON (builtins.readFile "${pkgs.playwright-driver}/browsers.json")).browsers;
  chromium-rev = (builtins.head (builtins.filter (x: x.name == "chromium") browsers)).revision;
  firefox-rev = (builtins.head (builtins.filter (x: x.name == "firefox") browsers)).revision;
  playwrightRuntimeLibraries = with pkgs; [
    stdenv.cc.cc.lib
    xorg.libxcb
    xorg.libX11
    xorg.libXext
    xorg.libXrandr
    xorg.libXcomposite
    xorg.libXcursor
    xorg.libXdamage
    xorg.libXfixes
    xorg.libXi
    xorg.libXrender
    gtk3
    pango
    atk
    cairo
    gdk-pixbuf
    glib
    alsa-lib
    freetype
    fontconfig
    dbus
  ];
in
{
  # https://devenv.sh/packages/
  packages = with pkgs; [
    git
    bashInteractive
    biome
    playwright-driver.browsers
  ];

  env = with pkgs; {
    PLAYWRIGHT_BROWSERS_PATH = "${playwright-driver.browsers}";
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${playwright-driver.browsers}/chromium-${chromium-rev}/chrome-linux64/chrome";
    PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH = "${playwright-driver.browsers}/firefox-${firefox-rev}/firefox/firefox";
    LD_LIBRARY_PATH = lib.makeLibraryPath playwrightRuntimeLibraries;
    BIOME_BINARY = "${biome}/bin/biome";
  };

  # https://devenv.sh/languages/
  languages.javascript = {
    # disable prepending node_modules/.bin to PATH
    # it is causing trouble with biome
    enable = true;
    bun = {
      enable = true;
      install = {
        enable = true;
      };
    };
  };

  # See full reference at https://devenv.sh/reference/options/
}
