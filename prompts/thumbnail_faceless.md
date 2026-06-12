# Thumbnail Faceless SOP — 16-bit Pixel Art (No Face)

## Purpose
Generate **faceless** 16-bit pixel-art thumbnails for concept/abstract videos. The standard `CONTENT_DOC_PROCESS_SOP.md` Step 8g layout puts Andy's pixel-art portrait in the left third — that's right for tutorials and show-and-tell videos. This SOP is the deliberate variant for videos where **logos, brand tiles, or text are the hero** and Andy's face would clutter the composition.

Same channel signature (gold pixel title, dark navy background, sparkles), same locked colors and fonts, just no face.

## When to Use vs Standard SOP

| Use `thumbnail-faceless` | Use standard `thumbnail-system` (face left third) |
|---|---|
| Concept / idea / abstract topic | Tutorial / step-by-step / show-and-tell |
| Script names brands or a number as the hook | Andy's reaction or authority is the hook |
| "X is now free" / "Y just dropped" / "Better than Z" | "How to do X" / "I built Y" / "Watch me Z" |
| Multiple recognizable logos belong on screen | Single tool focus |

**Don't blanket-rule.** Only one clean A/B has been run on face-vs-faceless (Karpathy autoresearch video, 51.9% vs 19.8%) and the face variant in that test was *also* the most cluttered, so the data is confounded. Default by topic type (concept → faceless, tutorial → face), and let the YouTube Test & Compare resolve close calls.

## Locked Style Constants

These are the channel's pixel-art signature — never change them:

| Property | Value |
|---|---|
| Aesthetic | 16-bit SNES pixel art — chunky visible pixels, flat limited palette, no anti-aliasing |
| Title font | Bold 16-bit pixel art |
| Title color | Vertical gradient `#FFD700` (top) → `#E8A800` (bottom) |
| Title shadow | Thick dark navy pixel shadow |
| Background | Dark navy pixel art (`#0a1428` to `#1a2440` range) |
| Sparkles | Optional — gold + white pixel sparkles. **Omit for contrarian framings** (the V6 "BETTER THAN / CLAUDE DESIGN" clean variant) where the message wants visual gravitas |
| Aspect ratio | 16:9, 1920×1080 |

## The 6 Layout Patterns

Each pattern has a different click-psychology fit. Pick one based on the video's hook.

### Pattern 1 — Brand Tile Row
**Use when:** the script names specific brands and viewers will recognize them ("Apple. Notion. Airbnb. Stripe. Uber.")
**Composition:**
- TOP: massive gold pixel title (1-2 words: "NOW FREE", "57 BRANDS", etc.)
- CENTER: horizontal row of 5 chunky white square tiles, each with one brand logo
- Optional `+` or arrow glyphs between tiles for "formula" feel
- BOTTOM RIGHT corner: pasted-as-is Claude burst + small badge ("71K STARS")
**Reference:** V1 NOW FREE (`assets/generated_visuals/2026-05-06_claude_design_faceless/v1_now_free_row.png`)

### Pattern 2 — Title Sandwich
**Use when:** you want top + bottom text wrapping the visual hero
**Composition:**
- TOP: massive gold pixel title (e.g. "57 BRANDS")
- CENTER: brand tile row (same as Pattern 1)
- BOTTOM: secondary gold pixel text (e.g. "FREE NOW")
- BOTTOM RIGHT: Claude burst sticker
**Watch:** two text bands fight the tile row's hierarchy. Less crisp than Pattern 1.
**Reference:** V2 57 BRANDS (`v2_57_brands_grid.png`)

### Pattern 3 — Repo Card Hero
**Use when:** there's a real GitHub repo, dashboard, or artifact that itself is recognizable proof
**Composition:**
- TOP: massive gold pixel title with the headline number ("71K STARS")
- CENTER: pixel-art rendering of the actual artifact (GitHub repo card with octocat icon, repo name, brand tile row inside, green star count)
- BOTTOM RIGHT: Claude burst sticker
**Hook type:** specificity / proof
**Reference:** V3 71K STARS (`v3_71k_stars_repo.png`)

### Pattern 4 — Two Anchors
**Use when:** the video has two clear protagonists (a tool + a brand, or a concept + an example)
**Composition:**
- TOP: massive gold pixel title ("71K STARS")
- BELOW TITLE: smaller gold subtitle ("NOW FREE")
- BOTTOM-LEFT: hero element 1 (e.g. Claude Code character, pasted-as-is)
- BOTTOM-RIGHT: hero element 2 (e.g. Apple logo on chunky white tile)
- Same vertical center, same size — visual balance
**Modeled on:** the autoresearch video's "DAY 1 / DAY 36" two-window layout (`assets/generated_visuals/2026-05-04_autoresearch_failure/thumb_pixel_art_v3_no_face.png`)
**Reference:** V4 Claude+Apple (`v4_claude_apple.png`)

### Pattern 5 — Strikethrough Contrarian
**Use when:** the hook is "Better than X" / "Forget X" / "X is dead" — and you want to lean *into* the conflict
**Composition:**
- TOP: massive gold pixel "BETTER THAN" (or similar)
- BELOW: gold pixel target name with a **chunky red diagonal pixel-art strikethrough** crossing it out
- BOTTOM: brand tile row (the "what to use instead")
- BOTTOM-RIGHT: Claude burst + small badge
**Caveat:** the strikethrough is the highest-curiosity mechanic on this list. Use it when you're comfortable with the contrarian framing — could read as anti-tool/anti-brand.
**Reference:** V5 BETTER THAN ~~CLAUDE DESIGN~~ (`v5_better_than.png`)

### Pattern 6 — Solo Title + Two Anchors (Clean)
**Use when:** Pattern 5's hook *without* the "punching down" energy. The contrarian-without-the-attack version.
**Composition:**
- Same as Pattern 4 (two anchors), but text reads "BETTER THAN" / "CLAUDE DESIGN" (or equivalent)
- **No sparkles** in background — clean dark navy keeps the message gravitas
- No strikethrough — the implied comparison alone does the work
**Reference:** V6 BETTER THAN clean (`v6_better_than_clean.png`)

## The Brand-Tile Rule

Recognizable brand logos go on **chunky white square tiles** with a thin black pixel border and slightly rounded corners. The brand mark is rendered as clean pixel art inside the tile. Mobile-readable at 320×180.

This is the channel's faceless visual signature for "here are real brands you know." It works because:
- White tiles pop against the dark navy background
- The tile shape unifies disparate brand styles (Apple's silhouette, Stripe's wordmark, Notion's N) into one visual rhythm
- It echoes the inspiration thumbnail format from Jay E / RoboNuggets ("Copy Any Brand" thumb) which is a known viral structure for this niche

## The Pasted-As-Is Rule

When a brand asset has its own canonical look (Claude burst, Claude Code character), **don't redraw it in pixel art**. Pass the PNG as a reference image and use this exact prompt language:

> *"The [BRAND] character MUST appear in the final image EXACTLY as it looks in the reference image — identical colors, identical shape, identical [key features], identical outline. Treat it like a sticker being pasted onto the scene. DO NOT redraw it in pixel art style. DO NOT add visible pixels to it. The logo stays clean, flat, and crisp — it is the only element in the image that is NOT pixel art."*

Gemini can't do a literal PNG composite (it regenerates everything), but this language gets the output ~90% of the way there.

**Available pasted-as-is assets:**
- `assets/logos/claude_logo.png` — orange 8-point Claude burst
- `assets/logos/Claude Code logo character.png` — orange blocky `><` creature

Other brand logos (Apple, Notion, Airbnb, etc.) are rendered as pixel art inside white tiles — Gemini knows what they look like.

## Locked Prompt Template

Substitute `[TITLE TEXT]`, `[SUBTITLE TEXT]`, `[LAYOUT]`, `[VISUAL HERO]`, and `[BRAND ASSET DESCRIPTION]`. Leave the rest verbatim — this is the channel's locked signature.

```
The reference image is the [BRAND ASSET DESCRIPTION e.g. "Claude burst
logo: an orange 8-pointed starburst on white/transparent background"].

BRAND LOGO PLACEMENT RULE: When the [BRAND ASSET] appears in this
image, it MUST appear EXACTLY as in the reference — identical colors,
identical shape, identical [KEY FEATURES], identical outline. Treat
it like a sticker pasted onto the scene. DO NOT redraw it in pixel
art. DO NOT add visible pixels to it. The logo stays clean, flat,
crisp — the only non-pixel-art element.

Everything ELSE in the image is 16-bit SNES pixel art: chunky visible
pixels, flat limited color palette, no anti-aliasing, no smoothing,
no photorealism, pure retro pixel art aesthetic.

THIS IS A FACELESS THUMBNAIL — DO NOT include any human face, person,
or character. The hero is the [VISUAL HERO e.g. "brand logo tiles" /
"Claude character + Apple tile" / "GitHub repo card"] plus the title
text on top.

STRICT LAYOUT (follow exactly):

[INSERT LAYOUT BLOCK FROM ONE OF THE 6 PATTERNS ABOVE — TOP /
SUBTITLE / CENTER / BOTTOM CORNERS]

BACKGROUND: dark navy pixel art (#0a1428 to #1a2440 range) [WITH
subtle blue glow and scattered gold + white pixel sparkles around
the title and hero | OR for clean variant: completely clean — NO
sparkles, NO stars, NO scattered dots, NO glow, NO decorations].
Pure pixel art background — no gradients.

Output must be 16:9 aspect ratio (1920x1080). The [BRAND ASSET]
must look IDENTICAL to the reference (flat, crisp, not pixelated) —
every other element is pure 16-bit SNES pixel art.

NO FACE. NO PERSON. NO ANDY.
```

## Generation Recipe

```python
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from google import genai
from google.genai import types

ROOT = Path('/Users/andershafell/Documents/Claude Folder')
OUT_DIR = ROOT / f'assets/generated_visuals/{DATE}_{TOPIC}_faceless'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Load .env
for line in (ROOT / '.env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        k, v = line.strip().split('=', 1)
        os.environ.setdefault(k, v)

client = genai.Client(api_key=os.environ['Google_AI_Studio'])

# Load brand asset (pasted-as-is reference)
asset = (ROOT / 'assets/logos/claude_logo.png').read_bytes()  # or Claude Code character

VARIANTS = [
    ('v1_<pattern>.png', PROMPT_V1),
    ('v2_<pattern>.png', PROMPT_V2),
    ('v3_<pattern>.png', PROMPT_V3),
]

def gen(name_and_prompt):
    name, prompt = name_and_prompt
    out = OUT_DIR / name
    parts = [
        types.Part.from_bytes(data=asset, mime_type='image/png'),
        prompt,
    ]
    resp = client.models.generate_content(
        model='gemini-3.1-flash-image-preview',  # Nano Banana 2
        contents=parts,
        config=types.GenerateContentConfig(response_modalities=['IMAGE', 'TEXT']),
    )
    for part in resp.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            out.write_bytes(part.inline_data.data)
            return out
    return None

with ThreadPoolExecutor(max_workers=3) as ex:
    results = list(ex.map(gen, VARIANTS))
```

**Model:** `gemini-3.1-flash-image-preview` (Nano Banana 2) — fast, channel-default for faceless variants.
**Note:** the 2026-05-06 reference set V1-V6 was generated on `gemini-3-pro-image-preview` (Nano Banana Pro). The Pro variant produces marginally cleaner pixel-art typography but is slower. Flash is the locked default; switch to Pro only if a regen comes back with mangled letters.

## Where Things Live

| What | Where |
|------|-------|
| Reference set (V1-V6) | `assets/generated_visuals/2026-05-06_claude_design_faceless/` |
| Brand burst asset | `assets/logos/claude_logo.png` |
| Brand character asset | `assets/logos/Claude Code logo character.png` |
| Standard SOP (face) | `skills/CONTENT_DOC_PROCESS_SOP.md` Step 8g |
| Standard pipeline (face) | `pipeline/thumbnail_system/generate_thumbnail.py` |
| Packaging strategy | `skills/PACKAGING_EXPERT_SOP.md` |

## Rules
- Title text max 4 words, ideally 2-3, mobile-readable at 320×180
- Brand-tile row uses chunky white squares with thin black borders, never gradient backgrounds
- Pasted-as-is rule for any brand asset that has its own canonical look (Claude burst / character)
- Sparkles are OPTIONAL — omit for clean contrarian variants (Pattern 6)
- Don't mix patterns — pick one and execute it cleanly
- Output to `assets/generated_visuals/YYYY-MM-DD_topic_faceless/` and use prefixes `v1_`, `v2_`, `v3_` for variant ordering

## Feedback Log
> Before running this process, read all feedback below and apply it. If the same note appears 3+ times, promote it to a permanent instruction above and remove from here.

### 2026-05-06
- Created from the Claude DESIGN System packaging session. V1-V6 reference set generated. The 6 layout patterns documented above are derived from that session — they're not exhaustive but cover the most useful concept-video compositions seen so far.
- Pro model (`gemini-3-pro-image-preview`) produced cleaner pixel-art letterforms than Flash in informal testing. Locked default is Flash (per Andy 2026-05-06) for speed/cost; bump to Pro on regen if letterforms break.
- Apple logo on the white tile sometimes renders with a stray inner shadow — check before shipping. Stripe wordmark renders less crisp than other brands; consider rendering it slightly larger to compensate.
- The 5-tile brand row (Pattern 1) produces the most consistent and mobile-readable output of the 6 patterns. Default to it when the topic supports it.

### 2026-05-18
- New Pattern 4 variant — **brand-pairing with glow halos**: title top + brand A left + chunky gold "+" middle + brand B right, glow around both brand icons. Iteration showed that locked-composition variation (just BG/glow treatment) is more A/B-useful than divergent compositions when testing energy/feel. Three glow treatments that worked: classic gold + sparkles, electric cyan + lightning bolt corners, soft white halo with NO sparkles (premium minimal).
- AgentFlow Dock logo (`assets/logos/agentflow_logo_dock.png`) is the canonical AgentFlow brand asset for faceless thumbs — distinct from the pixel-leaf cluster used in face thumbs.
- Chunky gold pixel-art "+" as a connector glyph between two brand icons reads instantly as pairing/formula. Worth promoting to a reusable element.
- Flash mangled "TERMINAL" letterforms in a strikethrough variant (corner pixels jagged). Confirms the existing Pro-fallback rule — but only escalate when the word is genuinely unreadable at 320×180; minor jaggedness at full size is fine.
