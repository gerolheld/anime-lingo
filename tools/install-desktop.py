#!/usr/bin/env python3
"""Install the already-built local Electron app without changing browser settings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

project = Path(__file__).resolve().parent.parent
source = project / 'dist/desktop/linux-unpacked'
if not (source / 'anime-lingo').is_file():
    raise SystemExit('Сначала выполните npm run desktop:pack')
home = Path.home()
target = home / '.local/opt/anime-lingo'
target.parent.mkdir(parents=True, exist_ok=True)
staging = target.with_name('anime-lingo.installing')
if staging.exists():
    shutil.rmtree(staging)
shutil.copytree(source, staging)
if target.exists():
    target.rename(target.with_name('anime-lingo.previous-' + time.strftime('%Y%m%d-%H%M%S')))
staging.rename(target)
binary = target / 'anime-lingo'
bin_dir = home / '.local/bin'
bin_dir.mkdir(parents=True, exist_ok=True)
launcher = bin_dir / 'anime-lingo'
# Fixed absolute path, shell quoting supports spaces and literal metacharacters.
import shlex
launcher.write_text('#!/usr/bin/env bash\nexec ' + shlex.quote(str(binary)) + ' "$@"\n')
launcher.chmod(0o755)
icons = home / '.local/share/icons/hicolor/512x512/apps'
icons.mkdir(parents=True, exist_ok=True)
shutil.copyfile(project / 'desktop/assets/icon.png', icons / 'anime-lingo.png')
applications = home / '.local/share/applications'
applications.mkdir(parents=True, exist_ok=True)
desktop = applications / 'anime-lingo.desktop'
desktop.write_text('[Desktop Entry]\nType=Application\nVersion=1.0\nName=Anime Lingo\nComment=Субтитры и улучшение аниме с локальным ИИ\nExec="' + str(binary).replace('\\', '\\\\').replace('"', '\\"') + '" %F\nIcon=anime-lingo\nTerminal=false\nCategories=AudioVideo;Player;\nStartupWMClass=anime-lingo\nMimeType=video/mp4;video/x-matroska;video/webm;\n')
subprocess.run(['update-desktop-database', str(applications)], check=False, capture_output=True)
print(json.dumps({'application': str(binary), 'launcher': str(launcher), 'menu': str(desktop)}, ensure_ascii=False, indent=2))
