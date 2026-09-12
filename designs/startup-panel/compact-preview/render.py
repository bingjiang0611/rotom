"""Render cell-aligned design proposals, NOT screenshots of the running application."""
from pathlib import Path
import textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
CELL, LINE, PAD = 12, 24, 24
FONT = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 20)
COLORS = {'bg': '#1b1d22', 'text': '#dfe3ea', 'dim': '#9a9fa9', 'line': '#474b55', 'heading': '#e9bc72',
          '.': '#1b1d22', 'r': '#ef7058', 'o': '#f8ab59', 'w': '#fff1d8', 'b': '#30404c', 'g': '#8dabb4'}
# Front-facing, deliberately simplified oven badge: no shaded face or oversized grin.
SPRITE = [
    '.........r.........',
    '........ror........',
    '.rr.....ror.....rr.',
    'rwr...rrrorrr...rwr',
    'rwr..rooooooor..rwr',
    '.rrr.rooooooor.rrr.',
    '...rrrowwowworrr...',
    '.....rowbowbor.....',
    '.....rooooooor.....',
    '.....robbbbbor.....',
    '.....robgwbbor.....',
    '.....robbbbbor.....',
    '......rooooor......',
    '......rr...rr......',
]
# Kept in sync with production ROTOM_PIXELS (rotom-header.ts), traced in D-ROTOM-STARTUP-06.
MINI = [
    '.........ror.........',
    '..rr...rrrorrr...rr..',
    '..rrr.rooooooor.rrr..',
    '..rwrrooooooooorrwr..',
    '...wrrooooooooorrw...',
    '...rwrrooooooorrwr...',
    '....rrrowoooworrr....',
    '.....rrooooooorr.....',
    '.....robbbbbbbor.....',
    '.....robgggggbor.....',
    '......rbgggggbr......',
    '.......rooooor.......',
    '.......rooroor.......',
    '.......ror.ror.......',
]
# Example labels copied from the requested categories, not a live resource query.
SECTIONS = [
    ('Context', '~/.pi/agent/AGENTS.md, CLAUDE.md'),
    ('Skills', 'design-loop, dws, evaluate-dev-agent, mobile-use, pi-subagents, qiaomu-goal-meta-skill, skill-doctor, yao-meta-skill'),
    ('Extensions', 'browser, coding-policy, herdr-agent-state.ts, observability, qoder, third-party'),
]

def badge(draw, grid, x, y):
    width = len(grid[0])
    assert all(len(row) == width for row in grid), [(i, len(r)) for i, r in enumerate(grid)]
    for row, pixels in enumerate(grid):
        for col, pixel in enumerate(pixels):
            if pixel != '.':
                assert pixel in COLORS
                xx, yy = x + col * CELL, y + row * (LINE // 2)
                draw.rectangle((xx, yy, xx + CELL - 1, yy + LINE // 2 - 1), fill=COLORS[pixel])

def sections(width):
    rows = []
    for i, (name, content) in enumerate(SECTIONS):
        if i: rows.append(('', 'dim'))
        rows.append((f'[{name}]', 'heading'))
        rows.extend((line, 'dim') for line in textwrap.wrap(content, width, break_long_words=False, break_on_hyphens=False))
    assert all(len(text) <= width for text, _ in rows)
    return rows

def render(variant, cols):
    compact = variant == 'B'
    left = 13 if compact else 21
    gap = 2 if compact else 3
    inset = 0 if compact else 1
    right = cols - left - gap - inset * 2
    content = sections(right)
    body_rows = max(len(content), 9 if not compact else 5)
    height_rows = body_rows + (3 if compact else 4)
    im = Image.new('RGB', (cols * CELL + PAD * 2, height_rows * LINE + PAD * 2), COLORS['bg'])
    draw = ImageDraw.Draw(im)
    title = 'rotom'
    draw.text((PAD + inset * CELL, PAD), title, font=FONT, fill=COLORS['text'])
    draw.text((PAD + (inset + 6) * CELL, PAD), 'v0.1.0-alpha.11', font=FONT, fill=COLORS['dim'])
    y = PAD + 2 * LINE
    if not compact:
        draw.rectangle((PAD, y - LINE // 2, PAD + cols * CELL - 1, y + body_rows * LINE + LINE // 2), outline=COLORS['line'])
        divider = PAD + (inset + left + 1) * CELL
        draw.line((divider, y - LINE // 2, divider, y + body_rows * LINE + LINE // 2), fill=COLORS['line'])
    grid = MINI if compact else SPRITE
    bx = PAD + (inset + (left - len(grid[0])) // 2) * CELL
    badge(draw, grid, bx, y + LINE)
    if not compact:
        label = 'GPT-6 Astra'
        draw.text((PAD + (inset + (left - len(label)) // 2) * CELL, y + 9 * LINE), label, font=FONT, fill=COLORS['text'])
    rx = PAD + (inset + left + gap) * CELL
    for i, (text, role) in enumerate(content):
        draw.text((rx, y + i * LINE), text, font=FONT, fill=COLORS[role])
    file = ROOT / f'{variant.lower()}-{cols}.png'
    im.save(file)
    return im

if __name__ == '__main__':
    for cols in (52, 80):
        a, b = render('A', cols), render('B', cols)
        board = Image.new('RGB', (max(a.width, b.width), a.height + b.height + 96), '#101216')
        d = ImageDraw.Draw(board)
        d.text((PAD, 12), 'A  /  compact card', font=FONT, fill=COLORS['text'])
        board.paste(a, (0, 48))
        d.text((PAD, a.height + 60), 'B  /  minimal sidebar', font=FONT, fill=COLORS['text'])
        board.paste(b, (0, a.height + 96))
        board.save(ROOT / f'compare-{cols}.png')
    print('Rendered A/B at 52 and 80 columns. Static design proposals only.')
