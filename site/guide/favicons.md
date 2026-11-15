# Favicons

A favicon is fetched once per site, on a first visit, so its bytes are paid once by every new visitor. imgtune checks the
icons a page declares, and flags the ones that are much bigger than the browser needs.

## What is checked

- The icons the page declares: `<link rel="icon">` and `apple-touch-icon`. When no icon is declared, `/favicon.ico` is
  checked.
- A favicon over 10 KB, or an apple-touch-icon over 30 KB, is flagged.
- Each icon is fetched once per run, not once per viewport.

## The numbers

- **The saving** comes from a real re-encode to the size the browser uses: 32 px for a favicon, 180 px for an
  apple-touch-icon, as a PNG (sharp).
- An ICO file is read through its largest PNG frame. An ICO with no PNG frame is not decoded, so its finding has no saving.

## The fix

Serve a 32 px PNG for a favicon and a 180 px PNG for an apple-touch-icon, or an SVG favicon when the logo is vector. The
finding gives the expected bytes.

## Limits

- A logo with fine detail can lose it at 32 px. Look at the re-encoded icon before you replace the file.
- A small saving of a favicon is labelled a lead: it is real, but small, so it sorts after the larger savings.
- `--no-resources` turns this check off. See [Resources](/guide/resources) for the flags and the budget.
