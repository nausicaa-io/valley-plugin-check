# Check

Find duplicate filenames and notes that differ from their templates, with warnings in Valley's footer.

## Features

- Check for duplicate filenames while ignoring file extensions.
- Compare notes with the expected frontmatter keys, order, and value types in their templates.
- Exclude folders, path patterns, extensions, or selected frontmatter keys.
- Choose which checks are enabled in the plugin's settings.

## Install

Open **Settings → Plugins → GitHub**, click **+**, and enter:

`https://github.com/nausicaa-io/valley-plugin-check`

Review the repository and plugin details, select **main**, and click **Install**. The repository includes the compiled plugin; installation does not require Git or npm.

## Use

Open **Settings → Check** to configure filename and template checks. Add folders or patterns that should be excluded. The plugin reports issues for you to review; it does not rewrite your notes to fix them.

## Requirements and updates

Requires Valley desktop 0.1.0 or later and plugin API v4. Updates and branch changes are applied explicitly from GitHub settings. Removing the installation preserves your saved settings.

## Development

Use Node 24.19.0 and npm 11.17.0. Run `npm ci` and `npm run check` in this directory. The package owns its dependencies, tests, localization, and vendored SDK/tool/testkit archives; no Valley app checkout is required. `npm run check` validates imports, types, tests, and builds `runtime/index.js`. Commit rebuilt runtime files with source changes.
