# Chinese Tag Translation Dictionary

The web console's Chinese tag autocomplete is generated from the
[EhTagTranslation Database](https://github.com/EhTagTranslation/Database),
using its published `db.text.json` release mirror.

## Included data

The generated browser dictionary contains only the canonical English tag,
Chinese display name, and small project-local search aliases. To keep the web
bundle practical, generation is limited to the `female`, `male`, `mixed`,
`language`, and `other` namespaces. Small project-specific mappings outside
those namespaces may be retained by the updater.

Run the updater from the project root:

```powershell
.\scripts\dev-env.ps1
python .\scripts\update_tag_translations.py
```

For an offline or reproducible conversion, download `db.text.json` first and
pass it explicitly:

```powershell
python .\scripts\update_tag_translations.py --input .\path\to\db.text.json
```

The updater writes:

- `apps/web/src/lib/tag-translations.json`
- `apps/web/src/lib/tag-translations.meta.json`

## Attribution and license

The extracted translation names are adapted from the EhTagTranslation
community database. Its database text is provided under Creative Commons
Attribution-NonCommercial-ShareAlike 3.0 by default, with additional or
namespace-specific terms (including GFDL/CC variants) documented inside the
upstream database. The generated JSON files remain subject to those upstream
terms and are separate from this project's application code.

Upstream project: <https://github.com/EhTagTranslation/Database>

Published mirror: <https://github.com/EhTagTranslation/DatabaseReleases>
