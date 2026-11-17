# Third-party notices

Ottertrail's own code is licensed under the GNU Affero General Public License, version 3 only ([LICENSE](LICENSE)). The browser tracker in `packages/tracker` is licensed under the MIT License ([packages/tracker/LICENSE](packages/tracker/LICENSE)), so sites can include it freely.

This file lists third-party material in this repository and in what it builds.

## In this repository

### shadcn/ui

The components in `apps/web/src/components/ui/` and the hook `apps/web/src/hooks/use-mobile.ts` were generated with the shadcn CLI (settings in `apps/web/components.json`) and changed since. shadcn/ui is distributed under the MIT License:

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Used by what this repository builds

These are not stored in the repository: they are downloaded when installing dependencies or by a command.

### IP geolocation data

IP geolocation by [DB-IP](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). `vp run geo:update` downloads the database. The licence requires the credit "IP geolocation by DB-IP" wherever locations derived from it are shown.

### Data-center address ranges

`vp run geo:update` also downloads the address ranges that cloud providers publish for their customers (Amazon Web Services, Google Cloud, Microsoft Azure, Oracle Cloud, DigitalOcean, Akamai Cloud, Vultr), and finds the ranges of other hosting providers in DB-IP's [IP to ASN Lite](https://db-ip.com/db/download/ip-to-asn-lite) database, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ("IP to ASN data by DB-IP"). The repository holds none of them; each instance downloads its own copy.

### Web Vitals

The tracker's second script, `v.js` (`packages/tracker/src/vitals.ts`), bundles [web-vitals](https://github.com/GoogleChrome/web-vitals), Copyright 2020 Google LLC, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The built file starts with that notice.

### Fonts

The dashboard bundles two fonts, installed from npm, both licensed under the [SIL Open Font License 1.1](https://openfontlicense.org):

- Inter (`@fontsource-variable/inter`), Copyright 2016 The Inter Project Authors.
- JetBrains Mono (`@fontsource-variable/jetbrains-mono`), Copyright 2020 The JetBrains Mono Project Authors.

### npm dependencies

Other dependencies are installed from npm under their own licences, found in each package's `LICENSE` file. The dashboard and API builds bundle parts of them, the API all of its dependencies.

Each build writes `THIRD_PARTY_LICENSES.txt` beside its output (`apps/api/dist/`, `apps/web/dist/`), listing every npm package it bundles with the licence text the package ships (`scripts/third-party-licenses.ts`). For the dashboard, that includes the packages its stylesheet imports, such as the fonts above. The Docker image keeps both files, with `LICENSE` and this file, and an instance serves the dashboard's copy at `/THIRD_PARTY_LICENSES.txt`.
