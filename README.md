# StarWarsFFG_Enhancements

Module intended to provide minor enhancements for the [StarWarsFFG FoundryVTT system](https://github.com/StarWarsFoundryVTT/StarWarsFFG) without including any copyrighted content.

This repository is a fork of [wrycu/StarWarsFFG-Enhancements](https://github.com/wrycu/StarWarsFFG-Enhancements).
It shares the `ffg-star-wars-enhancements` module id, so it installs over the upstream module rather than alongside
it.

## Installing

1. Open Foundry VTT
2. Go to the "Add-on Modules" tab
3. Click the "Install Module" button
4. Copy the following link into the "Manifest URL" field:
   https://github.com/YeNov/StarWarsFFG-Enhancements/releases/latest/download/module.json
5. Click Install, after a few seconds the module should be installed.

If you already have the upstream module installed, uninstall it first: an in-place update keeps the manifest URL it
was installed with and would keep checking upstream for updates.

For support with this fork, open an [Issue](https://github.com/YeNov/StarWarsFFG-Enhancements/issues) here rather
than upstream. The upstream repository's wiki remains the reference for how the individual features work.

## Scope

This module is designed to supplement the
[StarWarsFFG FoundryVTT system](https://github.com/StarWarsFoundryVTT/StarWarsFFG). The enhancements included are aimed at providing sane defaults for common workflows which aren't technically part of the core rules, such as: intro crawls, datapads, hyperspace transitions, and attack animations.

**Note**: We do not aim to include any core-rule features. If it's something the FFG Star Wars system defines in rules, we believe the system module should support it. This module is about enhancing the play experience, not implementing the rules.

## Enhancements

### Features

-   Launch a customizable Opening Crawl based upon the [Kassel Labs Star Wars Intro Creator](https://github.com/KasselLabs/StarWarsIntroCreator)
-   Launch customisable Book of Boba Fett-style title cards
-   A shop generator
-   Easily create Bounties and Datapada entries for showing players
-   Provides support for automatic, configurable attack animations (with sounds!)
-   Automatically renames actors in combat (to generic "PC" and "NPC" slots)
-   Provides tips on how to spend combat dice results
-   Automatically adds a status to tokens which have the `Adversary` talent
-   Change scenes via a transition through hyperspace

### Utilities

-   Includes (open source) Star Wars-like fonts
-   Includes the most common macros from the Wiki

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests go to [YeNov/StarWarsFFG-Enhancements](https://github.com/YeNov/StarWarsFFG-Enhancements).

### What about copyright?

Creating a module like this is tricky - there's a fine line between helpful tweaks and straight-up including copyrighted assets. As such:

-   We specifically exclude any content to which we do not have rights
-   We provide licensing information for all third party assets we include

### A special thanks

-   A special thanks to `@Atreides`, `@StealthViper`, `@Space Ape 713`, `@Amera`, and `@Rysarian` for early testing and feedback / identifying bugs.
