# @ottertrail/sourcemaps

A command that uploads a website build's source maps to Ottertrail, so the error pages show stacks in the site's own code (`src/cart.ts:3:10`) instead of the minified bundle (`index-4f3a.js:1:28431`).

> **Not yet published to npm.** Until it is, run it from this repository: see [Running it from this repository](#running-it-from-this-repository).

It finds every `*.js.map`, `*.mjs.map`, and `*.cjs.map` file in a build directory, works out the URL path the browser loads each minified file from, and uploads each map, gzip-compressed, for one release. It needs Node.js 26 or later and has no dependencies.

## Usage

```sh
export OTTERTRAIL_SECRET_KEY=sk_...   # the project's secret key, from its settings
ottertrail-sourcemaps upload dist --release 1.4.2 --host https://analytics.example.com
```

```text
Uploading 2 source maps for release 1.4.2 to https://analytics.example.com
stored    /assets/index-4f3a.js   assets/index-4f3a.js.map
replaced  /assets/vendor-9c1e.js  assets/vendor-9c1e.js.map
Release 1.4.2: 1 stored, 1 replaced, 0 failed.
```

| Option                  | Meaning                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--release <release>`   | Required. The release, the same as the tracker's `data-release` (below).                                                                                                                                                                                    |
| `--host <url>`          | Required. The Ottertrail address, such as `https://analytics.example.com`, with no path.                                                                                                                                                                    |
| `--url-prefix <path>`   | Where the build directory is served on the site. Default `/`.                                                                                                                                                                                               |
| `--concurrency <n>`     | Uploads at the same time, 1 to 8. Default 2, the server's limit for one project: it stores 2 of a project's maps at once and asks the rest to wait (429), and the command sends them again. Those waits are not failures, but each one sends its map again. |
| `--dry-run`             | List what would be uploaded, with each file's URL path, and send nothing.                                                                                                                                                                                   |
| `--delete-after-upload` | Delete each `.map` file once its upload succeeded.                                                                                                                                                                                                          |

The secret key is read from the `OTTERTRAIL_SECRET_KEY` environment variable only. There is no flag for it, because command lines end up in shell history and CI logs, and the command never prints it. A dry run works without a key.

Exit codes: `0` when every map was uploaded, `1` when an upload or a deletion failed (or no maps were found), `2` when the command line or the key is wrong. A map whose minified file is not next to it is skipped with a warning.

When the server asks to wait (429, 503), a proxy in front of it answers 502 or 504, or it cannot be reached, an upload is tried again up to 4 times, waiting as its `Retry-After` header says, or 1, 2, then 4 seconds. A refused key, an install without source maps, or a full storage allowance stops the uploads that have not started, since they would all fail the same way.

## Keep the maps off the public site

A source map usually holds the site's original source code. Build the maps "hidden": written to disk, but without the `//# sourceMappingURL=` comment that tells browsers where to find them. In Vite:

```ts
// vite.config.ts
export default defineConfig({
  build: { sourcemap: "hidden" },
});
```

Then upload them and delete them before the build is deployed, so they are not served at all:

```sh
ottertrail-sourcemaps upload dist --release "$RELEASE" --host https://analytics.example.com --delete-after-upload
```

`--delete-after-upload` deletes only `.map` files that were uploaded. A map that failed stays, so you can try again, and the command exits with `1`: let that stop the deploy. Nothing is deleted on a dry run.

## The URL path of each file

Ottertrail matches a stack frame to a map by the path of the frame's URL, without the origin: a frame in `https://www.example.com/assets/index-4f3a.js` matches the map uploaded for `/assets/index-4f3a.js`. The command works out that path from the file's place in the build directory and `--url-prefix`:

| Build directory file        | `--url-prefix`                 | URL path                       |
| --------------------------- | ------------------------------ | ------------------------------ |
| `dist/assets/index-4f3a.js` | `/` (default)                  | `/assets/index-4f3a.js`        |
| `dist/assets/index-4f3a.js` | `/static/` (or `static`)       | `/static/assets/index-4f3a.js` |
| `dist/assets/index-4f3a.js` | `https://cdn.example.com/app/` | `/app/assets/index-4f3a.js`    |
| `build/my app.js`           | `/`                            | `/my%20app.js`                 |

Use the prefix your bundler puts in front of asset URLs, such as Vite's `base`. A CDN's host does not matter, only its path. Run with `--dry-run` and compare the paths with those in your site's page source or in the browser's network panel. When the error page says no maps cover a stack, it lists the paths it looked for.

## The release

An error is mapped with the maps of its own release, so `--release` must be exactly the tracker's `data-release` for the same build:

```html
<script
  defer
  src=".../tracker.js"
  data-key="pk_..."
  data-host="https://analytics.example.com"
  data-release="1.4.2"
></script>
```

An error without a release cannot be mapped. A commit hash makes a good release: set it once in the build and use it in both places. A release has 1 to 200 characters and no spaces or control characters. Uploading the same release and file again replaces the earlier map.

## In CI

A GitHub Actions job, with the secret key stored as a repository secret:

```yaml
- name: Build
  run: npm run build # writes dist/ with hidden source maps and data-release="${{ github.sha }}"
- name: Upload source maps
  env:
    OTTERTRAIL_SECRET_KEY: ${{ secrets.OTTERTRAIL_SECRET_KEY }}
  run: >
    node tools/ottertrail-sourcemaps.js upload dist
    --release "${{ github.sha }}"
    --host https://analytics.example.com
    --delete-after-upload
- name: Deploy
  run: ./deploy.sh dist
```

`tools/ottertrail-sourcemaps.js` is the built command, copied into the site's repository (see below). Once the package is on npm, this becomes `npx @ottertrail/sourcemaps upload ...`.

## Running it from this repository

From the root of the Ottertrail repository, Node.js runs the TypeScript source directly:

```sh
OTTERTRAIL_SECRET_KEY=sk_... node packages/sourcemaps/src/cli.ts upload /path/to/site/dist \
  --release 1.4.2 --host https://analytics.example.com --dry-run
```

Or build it into one file with no dependencies, which can be copied into a site's repository:

```sh
vp -C packages/sourcemaps run build   # writes packages/sourcemaps/dist/cli.js
node packages/sourcemaps/dist/cli.js --help
```

Tests: `vp -C packages/sourcemaps test`. They upload to a local HTTP server started by the test.

## License

MIT, like the tracker; see [LICENSE](LICENSE). The rest of Ottertrail is AGPL-3.0.
