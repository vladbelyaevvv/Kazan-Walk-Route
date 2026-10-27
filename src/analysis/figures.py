"""Publication figures from archived results; no network or metric editing."""
from pathlib import Path
import json
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
RUN = os.environ.get('KAZAN_RUN_ID', 'stage5-v1')
summary = json.loads((ROOT / 'data/processed' / RUN / 'summary.json').read_text(encoding='utf-8'))
raw = ROOT / 'data/raw' / RUN
rows = json.loads((raw / 'results.json').read_text(encoding='utf-8'))
pairs = json.loads((ROOT / 'data/processed' / RUN / 'paired.json').read_text(encoding='utf-8'))
timings = json.loads((raw / 'runtime.json').read_text(encoding='utf-8'))
catalog = json.loads((raw / 'snapshot/data/places_catalog_full.json').read_text(encoding='utf-8'))
OUT = ROOT / 'reports/figures'
OUT.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False,
                     'axes.spines.right': False, 'svg.fonttype': 'none'})
algorithms = [('nearest_feasible', 'Базовый', '#315b48'), ('zone_progression_greedy', 'Зональный', '#d56b47')]
budgets = [60, 90, 120, 180, 240]

def save(fig, name):
    fig.tight_layout()
    fig.savefig(OUT / f'{name}.png', dpi=180, bbox_inches='tight')
    fig.savefig(OUT / f'{name}.svg', bbox_inches='tight')
    plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(11, 4))
for algorithm, label, color in algorithms:
    selected = [r for r in summary['byBudget'] if r['algorithm'] == algorithm]
    for ax, field, ylabel in [(axes[0], 'visited', 'Среднее число посещённых мест'),
                              (axes[1], 'zoneReentryCount', 'Среднее число повторных входов')]:
        ax.plot(budgets, [r[field]['mean'] for r in selected], marker='o', color=color, label=label)
        ax.set_xlabel('Бюджет прогулки, мин'); ax.set_xticks(budgets); ax.set_ylabel(ylabel); ax.grid(alpha=.2); ax.legend()
save(fig, 'main_metrics')

fig, axes = plt.subplots(1, 3, figsize=(13, 4))
for algorithm, label, color in algorithms:
    selected = [r for r in summary['byBudget'] if r['algorithm'] == algorithm]
    for ax, field, ylabel, factor in [(axes[0], 'totalWalkDistanceMeters', 'Средняя длина, км', .001),
        (axes[1], 'totalMinutes', 'Средняя длительность, мин', 1),
        (axes[2], 'uniqueZonesVisited', 'Среднее число зон', 1)]:
        ax.plot(budgets, [r[field]['mean'] * factor for r in selected], marker='o', color=color, label=label)
        ax.set_xlabel('Бюджет, мин'); ax.set_xticks(budgets); ax.set_ylabel(ylabel); ax.grid(alpha=.2); ax.legend()
save(fig, 'route_costs')

fig, axes = plt.subplots(1, 2, figsize=(12, 4))
sens = summary['sensitivity']; positions = list(range(len(sens)))
axes[0].bar(positions, [r['visitRetention'] for r in sens], color='#315b48')
axes[0].axhline(.9, color='#d56b47', linestyle='--', label='Заранее заданный порог 0,90')
axes[0].set_ylabel('Посещения зонального / базового'); axes[0].legend(fontsize=8)
for offset, field, label, color in [(-.18, 'baselineReentries', 'Базовый', '#315b48'),
                                   (.18, 'zonalReentries', 'Зональный', '#d56b47')]:
    axes[1].bar([p + offset for p in positions], [r[field] for r in sens], width=.36, color=color, label=label)
axes[1].set_ylabel('Суммарные повторные входы'); axes[1].legend()
for ax in axes:
    ax.set_xticks(positions, [r['profile'] for r in sens], rotation=35, ha='right'); ax.grid(axis='y', alpha=.2)
save(fig, 'sensitivity')

def median(values):
    return sorted(values)[len(values) // 2]
fig, ax = plt.subplots(figsize=(7, 4))
ax.boxplot([[median(r['millisecondsPerCallByBatch']) for r in timings if r['algorithm'] == algorithm]
            for algorithm, _, _ in algorithms], tick_labels=[label for _, label, _ in algorithms], showfliers=True)
ax.set_ylabel('Медиана партий, мс/вызов (Node.js)'); ax.grid(axis='y', alpha=.2)
save(fig, 'runtime')

fig, ax = plt.subplots(figsize=(7, 4))
primary_pairs = [r for r in pairs if r['profile'] == 'primary']
ax.scatter([r['stopsDifference'] for r in primary_pairs], [r['reentriesDifference'] for r in primary_pairs],
           alpha=.35, s=55, color='#315b48')
ax.axhline(0, color='gray', linewidth=.7); ax.axvline(0, color='gray', linewidth=.7)
ax.set_xlabel('Разница числа посещений: зональный − базовый')
ax.set_ylabel('Разница повторных входов: зональный − базовый'); ax.grid(alpha=.2)
save(fig, 'paired_tradeoff')

fig, ax = plt.subplots(figsize=(9, 6))
zones = list(dict.fromkeys(p['zone'] for p in catalog['places']))
for zone in zones:
    points = [p for p in catalog['places'] if p['zone'] == zone]
    ax.scatter([p['lon'] for p in points], [p['lat'] for p in points], label=zone, s=45)
ax.set_xlabel('Долгота, °'); ax.set_ylabel('Широта, °'); ax.grid(alpha=.2)
ax.set_aspect(1 / .562, adjustable='box')
ax.legend(loc='upper left', bbox_to_anchor=(1, 1), fontsize=8)
ax.set_title('Выбранные опорные точки и тематические группы')
save(fig, 'catalog_zones')
print(f'Created 6 figures in PNG and SVG: {OUT}')
