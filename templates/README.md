# Templates of XR, ES and BR (not decided)

The formats and identifiers of XR, ES and BR are not decided (`docs/history.ja.md`,
open questions). The templates here are proposals, made so that the pages of
these sub-libraries can be designed in the meantime. No muND data use them, and
the site does not publish them.

- `xr.schema.json`, `es.schema.json`, `br.schema.json`: the shape of a file of
  each sub-library, as JSON Schema. The proposals share LT's top-level member
  names and reference its `datasetType` and `meta` definitions. LT's rules
  that require or forbid metadata fields by dataset type belong to its
  top-level `allOf` and apply only to LT.
- `make_examples.py`: writes files with fictitious values that follow the
  templates. Run `python3 templates/make_examples.py "$(mktemp -d)"` to write
  them in a temporary folder. The tests check that they follow the templates.
