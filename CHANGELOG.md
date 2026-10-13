# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-10-13

### Changed
- The Browse tab's WHERE bar is replaced by an editable query box. It starts as `SELECT * FROM schema.table`. Edit it and press **Run** or Ctrl+Enter to page through any read-only query; **Reset** goes back to the default. Rows stay editable when every column the query returns belongs to the table and the primary key is included. Joins and computed columns make the result read-only.
- The query box is one card with an action bar: **Run** (with its Ctrl+Enter shortcut), **Reset**, and reload. An "Edited — press Run" note appears while the editor differs from the query shown in the grid.
- The rows-per-page selector moved to the bottom pagination bar.
- The theme button cycles through three modes: ☀ Light, ☾ Dark and ☕ **Warm**, a new low-glare paper-toned theme with matching SQL highlighting. Light and Dark have refreshed palettes, with Dark a little deeper and higher-contrast.

### Fixed
- Changing page in Browse no longer flickers. The current page stays visible, dimmed, until the next one arrives, and quick repeated ‹ › clicks keep stepping through pages.

### Removed
- The Browse **SQL** toggle. The query is always visible in the query box.
- The **All rows** option in the Browse rows selector. The largest page size is 1,000 rows again.

## [1.5.0] - 2026-10-12

### Added
- Connection groups. The connection form has a **Group** field that suggests existing groups, and the home page lists connections in sections by group, each with a **+** button to add a connection to it.
- Built-in **Local** group. Connections without a group belong to it. It is always listed first and cannot be deleted. Deleting any other group moves its connections to Local; no connection is removed.
- **All rows** option in the Browse rows selector. It loads the whole table on one page, capped at 100,000 rows.
- **SQL** toggle on the Browse tab that shows or hides the generated SELECT statement. The choice is remembered.

### Changed
- The sidebar is one tree: groups, then connections, databases, schemas and tables. Groups collapse and remember their state. Connections show their colour, and the current one stays highlighted and expanded. The connection dropdown is removed.
- The sidebar filter also matches connection names. Press `/` to focus it and Esc to clear it. A **+** button next to it adds a connection.
- The Browse tab hides the generated SELECT statement by default.

### Fixed
- A stray vertical scrollbar no longer appears on the tab bar.

## [1.3.1] - 2026-10-05

### Fixed
- The installed server was blocked on PCs with Windows Smart App Control turned on ("An Application Control policy has blocked this file"). The installer now ships the official signed `node.exe` from nodejs.org with the app files, instead of the unsigned pkg-built exe.
- If Windows still blocks the server, the launcher log now explains why.

## [1.3.0] - 2026-10-05

### Added
- Launcher window that replaces the console window. It has a glowing Start/Stop button, the server address, an **Open in browser** button, a short log, and a PSQL logo.
- System tray icon with a status dot. Its menu has Open in browser, Start/Stop, Show window, Start with Windows, and Exit. Closing the window keeps PostAdmin running in the tray.
- PSQL app icon for the launcher, installer, and shortcuts.
- `npm run build:launcher`.

### Changed
- The installer now installs the launcher as `PostAdmin.exe` and moves the server to `server\postadmin.exe`. Uninstalling also removes the Start with Windows entry.

## [1.2.0] - 2026-10-05

### Added
- Windows installer (`PostAdmin-Setup-X.Y.Z.exe`, built with Inno Setup). It installs per-user without admin rights and adds Start-menu and optional desktop shortcuts, an uninstaller, and a "launch when finished" option. Saved connections are kept on update and uninstall.
- GitHub Actions release workflow. Pushing a `vX.Y.Z` tag builds the installer and the portable `postadmin.exe` and attaches both to a GitHub Release.
- Update notifications. PostAdmin checks GitHub for the latest release and shows a dismissible banner with a download link when a newer version exists. Results are cached for 6 hours, and the check fails silently when offline. `POSTADMIN_NO_UPDATE_CHECK=1` turns it off.
- `npm run build:installer` and `npm run build:all` scripts.
- MIT `LICENSE` file.

## [1.1.0] - 2026-10-05

### Added
- ERD **Query window** button. It opens a separate SQL editor window, and the ER diagram highlights the tables, columns and relations used by the selection or by the statement under the cursor. A banner lists the matched tables and offers Focus and Clear.
- The ER diagram reloads automatically after a CREATE, ALTER, DROP or COMMENT statement is run from any SQL editor on the same database.

### Changed
- The ERD export buttons are combined into one **Export ERD** dropdown with draw.io, SVG and PNG options.
- The ERD tab now comes after Import.

## [1.0.0] - 2026-10-05

### Added
- Local Node/Express server that opens a phpMyAdmin-style UI in the browser. The server binds to `127.0.0.1` and rejects requests for any other host.
- Saved connections from `postgres://` URIs, stored in `%APPDATA%\PostAdmin\connections.json`. Includes a connection test, a URI builder, and per-connection colors. SQLAlchemy-style schemes such as `postgresql+asyncpg://` are accepted.
- Sidebar tree of databases, schemas, tables, views, sequences and functions, with a filter.
- Browse grid:
  - Pagination, sorting and a `WHERE` filter. Filters run in a read-only transaction.
  - Inline cell editing, a row edit dialog, copy-to-insert, and single or bulk delete.
  - Editing by `ctid` for tables without a primary key.
  - Primary-key columns are shown first.
- SQL editor (CodeMirror):
  - Autocomplete, and running either the selection or the whole editor.
  - Multiple result sets, EXPLAIN and EXPLAIN ANALYZE, and highlighting of the error position.
  - Query history, and export of results to CSV.
- Structure view: add, change or drop columns; create or drop indexes; drop constraints.
- Operations: create and drop databases, schemas and tables; rename and truncate tables. Every change shows the SQL and asks for confirmation first.
- Export:
  - SQL dumps of one table, several tables or a whole schema, taken from one consistent snapshot. Dumps include sequences, identity resets, foreign keys and views.
  - CSV export of a single table.
- Import:
  - SQL from a file or pasted text, run in a single transaction.
  - CSV into a table via `COPY`, with columns matched by the header row.
- ER diagram tab:
  - Automatic layout, draggable tables, pan and zoom, search, a keys-only mode, and fullscreen.
  - Download as draw.io (`.drawio`), SVG or PNG.
- Light and dark themes.
- Builds a standalone Windows executable with `npm run build:exe`.
- Shows the version in the UI and serves it at `GET /api/version`.

[Unreleased]: https://github.com/haseebkhan4321/postgres-sql-ui/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/haseebkhan4321/postgres-sql-ui/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/haseebkhan4321/postgres-sql-ui/releases/tag/v1.0.0
