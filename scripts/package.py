from pathlib import Path
import zipfile, hashlib
root=Path(__file__).resolve().parents[1]
target=root.parent/'Discord-Lyrics-Status-source.zip'
excluded={'node_modules','data','.git','.codex','__pycache__','test-results'}
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root)
        if not p.is_file() or any(part in excluded for part in rel.parts): continue
        if p.name=='.env' or p.suffix.lower() in {'.zip','.log','.db','.sqlite','.pem','.key'}: continue
        z.write(p,Path(root.name)/rel)
print(str(target))
print('Bytes:',target.stat().st_size)
print('SHA256:',hashlib.sha256(target.read_bytes()).hexdigest())
