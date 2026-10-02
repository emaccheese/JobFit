# Tino — brand guide

## The name and the story

**Tino** is a job-fit scorer and tracker for job seekers across the Americas.
In Spanish and Portuguese, *tener buen tino* / *ter bom tino* means to have good
judgment, a good eye: what Tino brings to a job search. It replaced "JobFit",
a name several other extensions already use.

**Tino is an armadillo.** Armadillos live across the Americas, from Texas to
Argentina, and their names already cross the four languages Tino speaks:
*armadillo* in Spanish and English, *tatu* in Portuguese and *tatou* in French,
both from Tupi. Tino is a three-banded armadillo, the kind that rolls into a
ball (Brazil's 2014 World Cup mascot was one).

- **It digs.** Tino goes through job postings and sniffs out the ones worth your time.
- **It has a shell.** What you tell Tino stays safe with you: the privacy promise, as a character.
- **It curls up** when there's nothing to show yet, and to say "this is safe".

**Taglines**

| | |
|---|---|
| English | Know before you apply. |
| Español | Buen tino para tu búsqueda de empleo. |
| Português | Bom tino na sua busca por emprego. |
| Français | Le bon flair pour votre recherche d'emploi. |

## Personality and voice

Tino is **curious, careful, candid and kind**: like a sharp friend who has hired
people. Warm and plain-spoken.

| Do | Don't |
|---|---|
| Say what's missing, plainly: "Kubernetes is required and isn't on your CV." | Soften it into nothing, or hype: "Amazing match! 🚀" |
| Explain trade-offs: "With OpenAI, your CV and the posting are sent to OpenAI." | Hide them in fine print. |
| Encourage without promising: "Worth applying." | Guarantee outcomes: "You'll get this job." |
| Keep "you" ungendered in Spanish and Portuguese: "¿Encaja contigo?" | "¿Eres apto/apta?" |
| Let Tino the character speak in onboarding and empty states. | Use the mascot in errors or warnings: a problem is never Tino's mood. |

## Colours

The extension's interface keeps its contrast-checked tokens (`job-fit-evaluator/ui.css`),
with **Tino blue** as the action colour. The mascot uses a softer palette of its
own, colourway "Denim & coral".

| Colour | Hex | Use |
|---|---|---|
| Tino blue | `#2350C4` | Buttons, links, focus rings. White on it 6.96:1. |
| Deep denim | `#2E4A7F` | The wordmark. |
| Denim | `#5B7DB8` | Tino's shell; the shell mark. |
| Light denim | `#8FAAD9` | The shell's bands. |
| Denim rim | `#4E6EA8` | The bottom edge of the shell. |
| Coral | `#E8907A` | The neckerchief: Tino's one warm accent. |
| Sand | `#EBCFAA` | Face, ears, paws, tail. |
| Blush | `#F2A99F` | Cheeks, inside the ears. |
| Ink | `#283246` | Outlines (light mode). In dark mode the outline turns `#E6E9EE` and the shell lightens (`#6E8FCB`), set inside each SVG. |

Score colours (green, amber, red) are for scores only; the brand never uses them.

## Using Tino

- **Poses:**
  - `tino.svg`: hello, for onboarding and the website.
  - `tino-reading.svg`: reading a posting through a magnifying glass, while scoring.
  - `tino-curled.svg`: curled up and safe, for privacy and empty states.
- **The shell mark** `tino-mark.svg` with the **wordmark** `wordmark.svg` is the logo. The dot of the "i" is a small shell.
- **The app icon** is Tino curled up, with a white sticker edge for dark toolbars: `icon.svg` for 48 and 128 px, and `icon-small.svg` (the shell alone) for 16 and 32 px.
- **Always decorative** in the interface: `alt=""` or `aria-hidden`. The words around Tino carry the meaning.
- **Not on job sites' pages**, except the small shell on the on-page card's badge.
- **No animation for now.** When it comes, it must stop under `prefers-reduced-motion`.

## Files and rebuilding

`brand/` is the only source. After editing anything here:

```bash
node tools/brand.js
```

That copies the drawings to `job-fit-evaluator/images/` (the extension) and
`docs/assets/` (the website), and renders `job-fit-evaluator/icons/icon-{16,32,48,128}.png`
with headless Chrome. `node tools/test.js` fails if a copy has drifted from its source.

## Designer brief (for v2)

This v1 was drawn in plain SVG to launch with. For a designer to polish:

- **Keep:**
  - the armadillo (three-banded, rolls into a ball);
  - the denim shell with tone-on-tone bands;
  - the coral neckerchief;
  - the sand face;
  - the curious raised eyebrow;
  - no glasses.
- **Personality:** curious, careful, candid, kind. Smart without being smug; warm without being childish. Adults trust it with their CV and salary.
- **Deliverables, as SVG:**
  - the three poses, plus "celebrating" (a strong match) and "thinking" (loading);
  - the shell mark;
  - the wordmark;
  - the app icon at 16, 32, 48 and 128 px (16 and 32 need their own simplified drawing);
  - a 440×280 store tile.
- **Constraints:**
  - flat colours from the palette above;
  - an outline that can switch to light in dark mode;
  - readable at 120 px wide;
  - the icon recognisable at 16 px on both light and dark toolbars.

## Uninstall form

`docs/goodbye.html` asks one question and can post the answer to a Google Form.
To set it up:

1. **Create the form** at forms.google.com, titled "Tino: why did you uninstall?". Add four questions:
   - **"Reason"**, short answer. It receives a code: `setup`, `slow`, `wrong-scores`, `privacy`, `done` or `other`.
   - **"Anything else"**, paragraph.
   - **"Language"**, short answer.
   - **"Version"**, short answer.
2. **Find the field ids.** In ⋮ → **Get pre-filled link**, type a placeholder in each field and click **Get link**. In the link:
   - each field appears as `entry.123456789=…`;
   - the form's id is the long code after `/forms/d/e/`.
3. **Fill in the `FORM` block** at the bottom of `docs/goodbye.html`:
   - `action: "https://docs.google.com/forms/d/e/<FORM_ID>/formResponse"`;
   - the four `entry.<id>` names.
4. **Test it:** open `https://<your site>/goodbye.html?lang=es&v=1.0.0`, answer, and check the response appears in the form.

Until the block is filled in, the page sends nothing and only says thanks.
