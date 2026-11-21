# Templates of XR, ES and BR (not decided)

The formats and identifiers of XR, ES and BR are not decided (`docs/history.ja.md`,
open questions). The templates here are proposals, made so that the pages of
these sub-libraries can be designed in the meantime. No muND data use them, and
the site does not publish them.

- `xr.schema.json`, `es.schema.json`, `br.schema.json`: the shape of a file of
  each sub-library, as JSON Schema. The envelope and the metadata are those of
  LT (`schema/v1/lt.schema.json`); only the entries differ.
- `make_examples.py`: writes files with fictitious values that follow the
  templates, `python3 templates/make_examples.py <folder>`. The files are not
  kept; the tests check that they follow the templates.
