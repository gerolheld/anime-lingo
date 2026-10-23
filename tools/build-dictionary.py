#!/usr/bin/env python3
"""Convert the attributed FreeDict/WikDict TEI into a compact offline lexicon."""
import hashlib
import json
from pathlib import Path
import sys
import unicodedata
import xml.etree.ElementTree as ET

source = Path(sys.argv[1] if len(sys.argv) > 1 else 'research/eng-rus.tei')
target = Path('extension/data')
ns = {'t': 'http://www.tei-c.org/ns/1.0'}
data = {}
for _, entry in ET.iterparse(source, events=('end',)):
    if entry.tag != '{http://www.tei-c.org/ns/1.0}entry':
        continue
    word = entry.findtext('t:form/t:orth', namespaces=ns)
    if word:
        key = word.lower()
        translations = [''.join(q.itertext()).strip() for q in entry.findall('.//t:cit[@type="trans"]/t:quote', ns)]
        # Accents are useful in Russian; keep them. Merge homographs.
        item = data.setdefault(key, {'t': [], 'p': entry.findtext('t:form/t:pron', default='', namespaces=ns)})
        for translation in translations:
            if translation and translation not in item['t']:
                item['t'].append(translation)
    entry.clear()
target.mkdir(parents=True, exist_ok=True)
items = list(data.items())
size = (len(items) + 3) // 4
total = 0
for i in range(4):
    path = target / f'eng-ru-{i}.json'
    path.write_text(json.dumps(dict(items[i*size:(i+1)*size]), ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    total += path.stat().st_size
(target / 'eng-ru.json').unlink(missing_ok=True)
print(json.dumps({'headwords': len(data), 'bytes': total, 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest()}))
