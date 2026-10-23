#!/usr/bin/env python3
"""Extract only the supplied reference artwork. No generated replacements."""
from pathlib import Path
import subprocess,json,hashlib,sys
source=Path(sys.argv[1]) if len(sys.argv)>1 else Path('/home/niger/Музыка/codex/4')
root=Path(__file__).resolve().parent.parent
out=root/'desktop/assets/reference';out.mkdir(parents=True,exist_ok=True)
images=sorted(source.glob('*.png'))
# Geometry is measured in the original 1672 x 941 reference images.
regions={
 'logo':(5,(31,38,62,63)),
 'settings-note':(5,(850,167,254,77)),
 'words-header':(3,(1040,0,170,155)),
 'panel-art':(2,(810,202,180,76)),
 'system-orb':(6,(350,155,178,178)),
 'qwen-symbol':(2,(1241,259,70,70)),
 'aligner-symbol':(2,(1241,377,70,73)),
 'translation-symbol':(2,(1241,499,70,73)),
 'enhance-symbol':(2,(1241,619,70,74)),
 'word-reactor':(3,(713,383,85,71)),
 'word-artificial':(3,(713,476,85,73)),
 'word-suitable':(3,(713,576,85,73)),
 'word-select':(3,(713,673,85,73)),
 'word-circuit':(3,(713,769,85,73)),
 'word-homunculi':(3,(713,856,85,73)),
 'sidebar-art':(5,(0,406,294,398)),
 'sidebar-history':(4,(0,407,280,398)),
 'header-room':(5,(1043,0,629,138)),
 'room-books':(5,(1043,38,629,100)),
 'room-footer':(1,(295,770,1377,171)),
 'library-room':(1,(1322,137,350,400)),
 'diagnostics-girl':(6,(1361,137,283,205)),
 'fate-cover':(2,(412,294,191,87)),
 'fate-library-cover':(1,(340,247,495,253)),
 'scene':(0,(321,144,880,248)),
 'steins-cover':(1,(340,557,190,126)),
 'rezero-cover':(1,(965,556,192,126)),
}
manifest=[]
for name,(index,(x,y,w,h)) in regions.items():
 src=images[index];dst=out/(name+'.png')
 subprocess.run(['magick',str(src),'-crop',f'{w}x{h}+{x}+{y}','+repage',str(dst)],check=True)
 manifest.append({'asset':dst.name,'reference':src.name,'crop':[x,y,w,h],'referenceSha256':hashlib.sha256(src.read_bytes()).hexdigest()})
(out/'provenance.json').write_text(json.dumps({'source':'User-supplied reference screenshots','generatedArtwork':False,'assets':manifest},ensure_ascii=False,indent=2)+'\n')
print('Extracted',len(manifest),'original reference artwork regions')
