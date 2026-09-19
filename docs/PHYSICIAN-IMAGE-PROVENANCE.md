# Homepage physician imagery — September 19, 2026

These images add people to the existing CredentialDOMD homepage. The original dark theme, navigation, marketing copy, pricing, forms and workflow demonstrations remain. No parallel redesign, fonts or scripts are included.

## Generated editorial scenes

The three fictional physician scenes were generated on September 19, 2026 with the built-in GPT Images tool, at the owner's request. No source photographs, real-person likeness references or book artwork were supplied. These people are not represented as customers, staff, the founder or endorsers. Each scene has a visible “AI-generated physician scene.” caption on the page and an empty image alternative because the scene is decorative.

- `physician-life-v3-*`: a physician leaving work, in the existing hero visual column. The natural portrait replaces the decorative phone illustration; the separate In Action workflow demonstrations remain.
- `physician-learning-v3-600.webp`: two colleagues learning together, in the existing CME feature card.
- `physician-colleagues-v3-*`: two colleagues in conversation, next to the existing state-guide introduction.

The images retain their full compositions. Captions appear beneath them, without overlays, fixed image heights, cover crops or face masks. Width caps keep the hero at 400px on desktop and 320px at tablet/phone sizes. Runtime files are compressed responsive WebP encodings; the PNG masters are not shipped. The 1200-named hero is actually 1122px wide, and its `srcset` descriptor reflects that width.

## Actual founder portrait

The owner explicitly authorized using his real photograph from [drericwhitney.com](https://drericwhitney.com/). The original [headshot.jpg](https://drericwhitney.com/headshot.jpg) was retrieved on September 19, 2026 as a 400 × 600 JPEG. The source page identifies Eric Whitney in its image alternative and Physician structured data. The photograph was not sent to an image model or retouched; only WebP encodings were made. Both placements retain the full portrait and pair it with his existing name and biography link.

- `eric-whitney-120.webp`: the existing hero founder byline.
- `eric-whitney-{120,400}.webp`: responsive versions beside his existing Practice quote.

## Runtime inventory

`scripts/package-site.mjs` explicitly copies only these seven files from `landing/images/` to `/images/`. Source originals and this provenance document are not packaged. The images add 279,322 bytes across all variants; a browser selects the appropriate responsive versions and lazy-loads the below-fold scenes.

| File | Pixels | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `eric-whitney-120.webp` | 120 × 180 | 3,564 | `8a92b953df62d0e7da2b74ab6f85be099481e509d1a34657c80665857973a195` |
| `eric-whitney-400.webp` | 400 × 600 | 24,706 | `b9ad0c76c69db80f072fa9c0179d5ecb2a84fd91de1432d64971a5fd215da65a` |
| `physician-colleagues-v3-1200.webp` | 1200 × 800 | 68,360 | `1c5dfe0fdbc03036bd0c44b6381ec81464286367468709de29e23837d9c18921` |
| `physician-colleagues-v3-600.webp` | 600 × 400 | 27,774 | `1e0ee84b6965560f05723899ea1a2c0d81b154ce49d5f9b6b1b73091107a0fb3` |
| `physician-learning-v3-600.webp` | 600 × 400 | 30,166 | `a66f559d4eb162f5e419d4b16f4949b3c74391afc09c124861cc7afd1bf7fdd5` |
| `physician-life-v3-1200.webp` | 1122 × 1402 | 87,334 | `db55d398ab1d58b30d3684f3368771372cbb86cc5b6f6bef8ccd68710131887e` |
| `physician-life-v3-600.webp` | 600 × 750 | 37,418 | `c9a9fbce8adbbbd01d6bb435e69d233e11239ff933e7187a87efa646ad529479` |

## Generation prompts retained for provenance


### physician-life-v3

Use case: photorealistic-natural. Asset type: premium editorial people photograph for the right-hand hero of CredentialDO, a physician credential-management website. Create an ORIGINAL portrait 4:5 photograph centered on a warm, believable mid-career woman physician in her early forties, medium-brown skin and natural dark wavy hair loosely tied back, wearing beautifully simple deep evergreen medical scrubs and carrying a soft tan shoulder bag as she steps out of a contemporary clinic into warm late-afternoon daylight. She looks slightly left of the camera with an unforced, subtle happy expression, an ordinary moment of a person finishing meaningful work and returning to her life. Single main person shown from waist up, face around the upper-middle 35 percent of the frame, with generous space above and around her so responsive crops keep the whole head. Background softly blurred pale limestone, muted greenery and modern glass, understated real architectural setting. Human connection is the image's clear focus. Natural skin texture, smile lines, slight hair movement, high-end candid magazine photography, calm warm ivory/evergreen palette, gentle cinematic daylight, real depth and photographic restraint. No posing with crossed arms, no exaggerated commercial grin, no desk, no paperwork, no laptop, no dominant stethoscope, no visible name badge, no patient, no blood, no medical procedure, no text, no watermark, no logos. A fictional composite editorial person; do not resemble a real public figure or existing customer. This is entirely new imagery for CredentialDO, no reuse of book artwork, no landscape hero.

### physician-colleagues-v3

Use case: photorealistic-natural. Asset type: people-centered editorial photo for the medical-license-guides card on a sophisticated physician website. ORIGINAL wide horizontal 3:2 frame, intentionally crop-friendly for a 2:1 card. Two mid-career physician colleagues in a light contemporary hospital corridor, a white man around 50 with short salt-and-pepper hair and a Black woman around 40 with natural tied-back hair, walking side by side in relaxed conversation. Their expressions are attentive and warm rather than camera-facing advertising smiles. Simple evergreen scrubs and an open ivory clinical coat, no visible badges, no printed names, no symbols or text. Medium close view with heads and shoulders centered together within middle 60 percent of width and faces near horizontal center height; ample headroom for a shallow crop. Warm natural daylight through blurred windows, understated sage and ivory background, realistic skin texture, genuine human gestures and natural anatomy, high-end candid editorial photography. Focus on their connection and professional confidence, no patient, no desk, no files as main subject, no charts or screens, no heroic pose, no medical procedures, no prominent stethoscopes, no logos/watermarks. Fictional editorial people, not actual customers or an endorsement; entirely new composition.

### physician-learning-v3

Use case: photorealistic-natural. Asset type: warm human editorial photograph for a physician continuing-medical-education resource card. ORIGINAL wide horizontal 3:2 frame, suitable for a shallow 2:1 website crop. Two adult physician colleagues learning together in a sunlit contemporary educational lounge: an East Asian woman physician in her late thirties wearing an understated cream blouse and a South Asian man physician around 45 wearing deep olive scrubs. Medium-close waist-up candid composition, they are thoughtfully discussing something on a small tablet held between them, only the back of the tablet visible. Faces and attentive expressions are the main subject and grouped within middle 60 percent of width, around vertical center so a shallow crop preserves complete heads. One is speaking with a restrained natural gesture; the other engaged, with a slight smile. Human, intelligent, unposed, no theatrical laughing. Soft window light, warm ivory and muted terracotta surroundings, shallow depth of field, realistic skin/hair and hand anatomy, elegant editorial photography. Furniture is incidental and not the subject. No desk still life, no readable screen or paper, no text, no brands, no logos, no watermark, no patient or medical procedure. Fictional editorial people only, not customer testimonials. Entirely new imagery, no reuse of existing book artwork.
