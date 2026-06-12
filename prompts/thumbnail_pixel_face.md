# Thumbnail Pixel Face — SOP

The channel's signature thumbnail style. 16-bit SNES pixel art: Andy's face on the left, bold gold title top-right, a clean tool/brand logo bottom-right. Every video gets one in this style.

---

## What you need

1. **Google Nano Banana Pro** access — model ID `gemini-3-pro-image-preview` via the Google AI Studio API. (Distinct from Replicate's "nano-banana-2" — this is the Google-native one that takes face refs.)
2. **3-4 face reference PNGs** of Andy — bundled in the `face_references/` folder next to this doc.
3. **1 brand logo PNG** (optional) — the tool the video is about. If the video has no specific brand, swap it for a small themed icon (cloud, lightning bolt, gear, etc.).
4. **A 2-4 word title** — the punchy version of the video's hook.

Output: a single 1920×1080 PNG.

---

## The locked layout (3 zones)

| Zone | Position | Contents |
|---|---|---|
| **Face** | Left 1/3 of the frame | Close-up pixel art Andy — head + tops of shoulders. Long flowing brown hair past the shoulders, full brown beard, white t-shirt, confident smile. Face fills the left third top-to-bottom. Must still read at YouTube thumbnail size (320×180). |
| **Title** | Top right (upper half of the right 2/3) | Bold 16-bit pixel art text. Vertical gradient bright yellow `#FFD700` → deep gold `#E8A800`. Thick dark navy pixel shadow. Max 4 words on 1-2 lines. |
| **Brand logo** | Bottom right (lower half of the right 2/3) | The tool/brand asset **pasted as-is** — not redrawn as pixel art. ~25% of total screen area (~480×540 in a 1920×1080 frame). |
| **Background** | Whole frame | Dark navy pixel art with subtle blue glow and a few pixel sparkles scattered around the title and logo. |

The contrast is the whole point: chunky pixel art everywhere **except** the brand logo, which stays clean and flat so it's instantly recognizable.

---

## Face references

Use 3-4 of the PNGs from the bundled `face_references/` folder.

The number in each filename marks the source clip (`adj_131_*`, `adj_194_*`, `adj_213_*`, `adj_218_*`, `adj_243_*`). Pick **one from each different prefix** for expression variety — don't use four refs all from `adj_131_*`.

The 5 included references cover different expressions/angles. Pick any 3-4.

**Important description detail:** Always describe Andy in the prompt as "long flowing brown hair past the shoulders and a full beard." Older versions of this prompt said "full head of thick hair" — that's out of date and produces a clean-shaven short-haired character that doesn't look like him.

---

## The locked prompt template

Copy this verbatim. Only substitute the four bracketed fields:

- `[TITLE TEXT]` — your 2-4 word title
- `[BRAND NAME]` — name of the tool (e.g. "Claude Code")
- `[BRAND DESCRIPTION]` — one-line visual description of the logo (e.g. "a chunky flat orange creature with a rounded rectangular body, '>' and '<' black eyes, short stubby legs, and a crisp white outline")
- `[BRAND KEY FEATURES]` — the distinctive features again, repeated so Gemini latches on (e.g. "orange body, '>' and '<' eyes, white outline")

```
These are reference photos. The first 4 are my face — I have long
flowing brown hair that falls past my shoulders and a full beard. The
5th image is the [BRAND NAME]: [BRAND DESCRIPTION].

BRAND LOGO PLACEMENT RULE (critical): The [BRAND NAME] MUST appear in
the final image EXACTLY as it looks in the reference image — identical
colors, identical shape, identical [BRAND KEY FEATURES], identical
outline. Treat it like a sticker being pasted onto the scene. DO NOT
redraw it in pixel art style. DO NOT add visible pixels to it. DO NOT
change its proportions. DO NOT change its expression. The logo stays
clean, flat, and crisp — it is the only element in the image that is
NOT pixel art.

Everything ELSE in the image is 16-bit SNES pixel art: chunky visible
pixels, flat limited color palette, no anti-aliasing, no smoothing,
no photorealism, pure retro pixel art aesthetic.

STRICT LAYOUT (follow exactly):

LEFT THIRD (left side of the 16:9 frame): a LARGE close-up pixel art
portrait of me — head and just the tops of my shoulders, zoomed IN.
My head and hair FILL almost the entire left third vertically
(top-to-bottom). This is a close-up portrait, NOT a small distant
avatar. Long flowing brown hair past the shoulders (flowing down to
the bottom of the frame on both sides of the face). Full brown beard.
Plain white t-shirt (only neckline and shoulder tops visible). The
face LIKENESS must match the reference photos — same eyes, nose,
beard shape, recognizable as the same person. Confident excited
expression, slight smile, looking directly at the viewer. Pixel art
— chunky pixels, flat colors, but detailed enough at this close-up
size to capture the likeness. Must still read at 320×180 preview
size (YouTube thumbnail scale).

TOP RIGHT (upper half of the right two-thirds): bold 16-bit pixel art
text '[TITLE TEXT]' on two lines. Vertical gradient from bright yellow
(#FFD700) to deep gold (#E8A800). Thick dark navy pixel shadow behind
the text. Text fills the upper right portion of the frame.

BOTTOM RIGHT (lower half of the right two-thirds): the [BRAND NAME]
PASTED AS-IS from the reference image, NOT redrawn in pixel art.
Covering approximately ONE QUARTER (25%) of the total screen area.
[Describe brand features verbatim again — colors, outline, facial
features]. Looks like the reference PNG placed directly onto the scene.

BACKGROUND: dark navy pixel art with subtle blue glow, a few pixel
sparkles scattered around the title text and the brand logo. Pure
pixel art background, no gradients.

Output must be 16:9 aspect ratio (1920x1080). The brand logo in the
bottom right must look IDENTICAL to the reference image (flat, crisp,
not pixelated) — every other element must be pure 16-bit SNES pixel
art style.
```

---

## How to call the API (Python reference)

Requires `pip install google-genai pillow` and a Google AI Studio API key (`GOOGLE_AI_STUDIO_API_KEY`).

```python
import os
from pathlib import Path
from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ['GOOGLE_AI_STUDIO_API_KEY'])

# 1. Load 3-4 face refs (one from each different adj_* prefix for variety)
face_files = [
    Path('face_references/adj_131_04.png'),
    Path('face_references/adj_194_01.png'),
    Path('face_references/adj_213_04.png'),
    Path('face_references/adj_243_02.png'),
]

# 2. (Optional) load the brand logo
brand_logo = Path('brand_logo.png')  # the tool the video is about

parts = [
    types.Part.from_bytes(data=f.read_bytes(), mime_type='image/png')
    for f in face_files
]
if brand_logo.exists():
    parts.append(types.Part.from_bytes(
        data=brand_logo.read_bytes(), mime_type='image/png'
    ))

# 3. Fill in the prompt template
PROMPT = open('prompt_template.txt').read()  # or paste the template above as a string
prompt = (PROMPT
    .replace('[TITLE TEXT]', 'YOUR TITLE')
    .replace('[BRAND NAME]', 'Claude Code')
    .replace('[BRAND DESCRIPTION]',
             "a chunky flat orange creature with a rounded rectangular "
             "body, '>' and '<' black eyes, and a white outline")
    .replace('[BRAND KEY FEATURES]', "orange body, '>' and '<' eyes, white outline")
)
parts.append(prompt)

# 4. Generate
response = client.models.generate_content(
    model='gemini-3-pro-image-preview',
    contents=parts,
    config=types.GenerateContentConfig(response_modalities=['IMAGE', 'TEXT']),
)

# 5. Save the first image part
for part in response.candidates[0].content.parts:
    if getattr(part, 'inline_data', None):
        Path('thumb_pixel_art.png').write_bytes(part.inline_data.data)
        break
```

Typical time: 30-60 seconds per generation. Try 2-3 generations and pick the best — Gemini varies run to run.

---

## What to vary, what stays locked

**Vary per video:**
- Title text (2-4 words)
- Brand name + description + key features (or drop the brand entirely and use a small themed icon if the video has no specific tool)

**Locked — do not change without explicit Andy approval:**
- Face on the left 1/3, close-up portrait
- Gold gradient title top-right
- Brand logo bottom-right at ~25% screen area, pasted-as-is
- Dark navy pixel art background with sparkles
- 16:9 / 1920×1080 output

This is the channel's visual signature. Consistency is the point.

---

## If Gemini drifts on the logo (fallback)

Gemini regenerates everything from scratch — even with the "paste as-is" language it sometimes redraws the logo as pixel art anyway. If a specific video's logo drift is unacceptable, generate the scene with an empty bottom-right and composite the real logo PNG in with PIL:

```python
from PIL import Image

scene = Image.open('thumb_bg.png')  # Gemini output with bottom-right left empty
logo = Image.open('brand_logo.png').convert('RGBA')

target_w = int(scene.width * 0.27)
ratio = target_w / logo.width
logo = logo.resize((target_w, int(logo.height * ratio)), Image.LANCZOS)

x = scene.width - logo.width - 40  # 40px right margin
y = scene.height - logo.height - 40  # 40px bottom margin
scene.paste(logo, (x, y), logo)

scene.save('thumb_final.png')
```

For most videos Gemini's approximation reads correctly at thumbnail size — only fall back to PIL when the logo really matters and Gemini won't behave.

---

## What's in this folder

- `thumbnail pixel face.md` — this doc
- `face_references/` — 5 curated face refs of Andy (one from each source clip). Use 3-4 of them per generation.
