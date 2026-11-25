# data/ — the muND database

Each LT file holds one metadata record and its data entries, one entry per line.
A publication can supply several files for different dataset types or for
set-ups distinguished by a metadata key. One Save in the data entry tool
records all pending file edits together.
Format: [docs/data-format.md](../docs/data-format.md). Edit with the data entry
tool ([guide](../docs/admin-guide.ja.md)); after editing by hand run
`python3 tools/mund.py fix <file>` and `python3 tools/mund.py validate`.
