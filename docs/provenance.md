# Source provenance

## Goal

Identify the pinned source references that informed Web Scraper and distinguish the project's adaptations and new work from those references without inventing licensing permissions.

## Context Pointers

| Reference                                                                                                                                                 | Inspected pin                              | Commit date       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------- |
| [GavinLonDigital/Python_WebScraping_Scripts](https://github.com/GavinLonDigital/Python_WebScraping_Scripts/tree/d4cb17e16309a25ef65a4397ab4e3c07a95eb6b8) | `d4cb17e16309a25ef65a4397ab4e3c07a95eb6b8` | 6 May 2026 UTC    |
| [GavinLonDigital/InfoData](https://github.com/GavinLonDigital/InfoData/tree/3f75b66b6ad8a699c3a3b232f54cd1a5c99c4ea6)                                     | `3f75b66b6ad8a699c3a3b232f54cd1a5c99c4ea6` | 31 March 2026 UTC |

Source inspection used pinned public text files and recursive repository trees. The tree/commit metadata was checked on 16–17 October 2026. This was not a complete byte-for-byte archive or a comprehensive rights audit.

## Adaptation boundaries

- **Python Booking:** the references supplied standard Playwright and managed-browser navigation/parsing flows. This project uses bounded inputs, navigation and cleanup, required hotel identity/URL validation, qualified optional stay fields, explicit failures and a shared BeautifulSoup parser. Managed transport uses ZenRows Browser Sessions.
- **Python Amazon:** the managed reference informed result traversal. This project uses ZenRows Fetch, validated ASINs/URLs, deduplication, qualified price text and nullable metadata. Standard Amazon and both Indeed modes were implemented against the project's contracts; corresponding reference files were absent from the inspected Python tree.
- **Express and source views:** InfoData informed the Express/controller/service separation, Amazon/TIOBE source routes, book-card intent and rank/icon/language table. This project adds the four-source run model, persistent snapshots/history, strict contracts, bounded workers, safe errors, input validation and recovery behavior.
- **Interface:** Webby's bee identity, sidebar/Overview, saved-run hierarchy and source-aware activity indicator are project-specific work built on the selected React/Vite/Bootstrap stack.
- **Browser/PDF utilities and verification:** no standalone equivalent utility files were present in the inspected references. The bounded CLI utilities, synthetic PDF checks and controlled run/API/browser regression coverage were implemented for this project.

The current project does not vendor the reference repositories, their dependency trees, scraped datasets or stored credentials. Attribution describes implementation lineage; it is not a claim that all project files are unchanged reference code or wholly unrelated original work.

## Constraints and licensing limits

The inspected repository trees contained no repository-wide `LICENSE`, `COPYING`, `COPYRIGHT` or `NOTICE` file, and GitHub's repository license metadata was null. InfoData's backend package declared `ISC`; the frontend and Python reference had no corresponding declaration. A package field alone does not establish a repository-wide license.

No blanket permissive license is assigned here. This record is attribution and a description of observed metadata, not a legal determination or a grant of rights. Before broader redistribution or relicensing, review substantive reused portions and applicable permissions specifically. Individual dependencies retain their own licenses. See [GitHub's licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) for the distinction between source visibility and licensing.

## Done When

The pinned references and adaptation boundaries remain traceable, no unsupported license or ownership claim is introduced, and later source or permission changes are assessed before changing this record.
