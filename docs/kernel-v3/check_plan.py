"""Validate task routing and dependency links without network or project dependencies."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent
cards = {}
errors = []
for path in (root / 'tasks').glob('T[0-9][0-9]-*.md'):
    key = path.name[:3]
    if key in cards:
        errors.append(f'duplicate task: {key}')
    text = path.read_text()
    def field(name):
        match = re.search(rf'^\| {name} \| (.*?) \|$', text, re.M)
        return match.group(1) if match else ''
    cards[key] = (path, field('执行'), field('依赖'))
    if int(key[1:]) >= 20:
        for required in ['执行', '依赖']:
            if not field(required):
                errors.append(f'{key}: missing {required}')
        if '05-delivery-contracts.md' not in text:
            errors.append(f'{key}: missing shared contract')
        if not ('## 验收' in text or '## 交付' in text or key in ['T66', 'T69']):
            errors.append(f'{key}: missing acceptance')
index = (root / 'tasks/README.md').read_text()
for key, (path, owner, deps) in cards.items():
    if int(key[1:]) < 20 and key != 'T17':
        continue
    row = next((line for line in index.splitlines() if line.startswith(f'| [{key}](')), None)
    if row is None:
        errors.append(f'{key}: missing index entry')
        continue
    cells = [part.strip() for part in row.split('|')]
    if cells[3] != owner or cells[4] != deps:
        errors.append(f'{key}: owner/dependencies differ from index')
    if f']({path.name})' not in row:
        errors.append(f'{key}: wrong index link')
graph = {key: set(re.findall(r'\bT\d{2}\b', value[2])) for key, value in cards.items()}
# T69 is a repeated acceptance gate; prose mentions its first execution, not a code dependency.
graph['T69'] = set()
visiting, done = set(), set()
def visit(key, stack):
    if key not in graph:
        errors.append(f'missing dependency {key} from {stack}')
        return
    if key in visiting:
        errors.append('dependency cycle: ' + ' -> '.join(stack + [key]))
        return
    if key in done:
        return
    visiting.add(key)
    for dep in sorted(graph[key]):
        visit(dep, stack + [key])
    visiting.remove(key)
    done.add(key)
for key in graph:
    visit(key, [])
for path in root.rglob('*.md'):
    for link in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if '://' in link or link.startswith('#'):
            continue
        if not (path.parent / link.split('#')[0]).exists():
            errors.append(f'{path.relative_to(root)}: broken link {link}')
if errors:
    raise SystemExit('\n'.join(errors))
future = [v for k, v in cards.items() if int(k[1:]) >= 20 and k not in ['T66', 'T69']]
count = sum(v[1] == 'minimax' for v in future)
print(f'PASS: {len(cards)} cards; dependencies acyclic; index owners/dependencies and links consistent.')
print(f'Future coding cards: minimax {count}/{len(future)} ({count/len(future):.0%}); grok {len(future)-count}.')
