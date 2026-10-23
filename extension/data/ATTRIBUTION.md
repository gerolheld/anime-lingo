# Offline English–Russian dictionary

Source: English–Русский FreeDict+WikDict dictionary, edition 2025.11.23,
maintainer/publisher Karl Bartel. https://freedict.org/ and https://www.wikdict.com/.
Base data: Wiktionary.org via DBnary, https://kaiko.getalp.org/about-dbnary/.
Original: https://download.freedict.org/generated/eng-rus/eng-rus.tei
SHA-256: 7c48ef3981903361ea90f8ef9a64e58cc7899341d0fb873c2f61198198cba7af

The TEI header licenses this edition under Creative Commons Attribution–ShareAlike
3.0 Unported: https://creativecommons.org/licenses/by-sa/3.0/.
The same license applies to eng-ru-*.json. See CC-BY-SA-3.0.txt.

Changes by Anime Lingo contributors (2026): converted TEI to JSON, lowercased
headwords, merged duplicate headwords and translations, retained the first IPA
pronunciation, omitted definitions, grammatical annotations and source markup.
62,181 source entries become 57,076 unique case-insensitive headwords.
Build script: tools/build-dictionary.py in the source distribution.

Context rules and morphology are separately implemented in core.js; they are
heuristics and do not replace a contextual translation model.
