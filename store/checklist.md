# Launch checklist

Everything in the repository is ready for an **unlisted** beta. These are the
steps only you can take, in order. Tick them as you go.

## Before the beta

- [ ] **Trademark search for "Tino"**, in the classes for software (9), online software services (42) and job services (35):
  - USPTO (United States): https://tmsearch.uspto.gov
  - IMPI (Mexico): https://marcia.impi.gob.mx
  - INPI (Brazil): https://busca.inpi.gov.br
  - CIPO (Canada): https://ised-isde.canada.ca/cipo/trademark-search
  - TMview (many offices at once): https://www.tmdn.org/tmview

  A professional search is worth it before spending on the brand.
- [ ] **A dedicated email address** for Tino. Replace `<<CONTACT_EMAIL>>` in `docs/privacy.html` (four places) with it.
- [ ] **Turn on GitHub Pages:** repository Settings → Pages → Deploy from a branch → `main` / `docs`. The site appears at https://emaccheese.github.io/JobFit/.
  - If you rename the repository (to `tino`, say), the address changes. Update `siteUrl` in `job-fit-evaluator/defaults.js` and `homepage_url` in `manifest.json` to match, and the links in `docs/` and `store/`.
  - Or point a domain of your own at it (GitHub Pages → Custom domain) and use that address in the same places.
- [ ] **Update the repository description** on GitHub. It still says "no API keys, no cloud, nothing leaves your machine", which stopped being true when the OpenAI option arrived. For example: "Tino: know before you apply. A private job-fit scorer and tracker for Chrome, with a local model or your own OpenAI key."
- [ ] **The uninstall form** (Google Forms): create it as described in `brand/brand.md` ("Uninstall form"), then copy its ids into `docs/goodbye.html`.

## The beta (unlisted)

- [ ] **Chrome Web Store developer account** (one-time US$5): https://chrome.google.com/webstore/devconsole
- [ ] **Package:** zip the contents of `job-fit-evaluator/` (the folder's files, not the folder). Run `node tools/test.js` first.
- [ ] **Listing:** copy from `store/listing.md`; screenshots from `store/screenshots/`; the small promo tile `store/promo-small.png`.
- [ ] **Privacy practices tab:** from `store/permissions.md`.
- [ ] **Visibility: Unlisted.** Share the link with a handful of testers; ask them to try it on real postings for a week.

## Public launch (with Tino Cloud, Phase 4)

- [ ] Switch the listing to **Public**.
- [ ] Update the landing page's "Get Tino" button to the store link.
- [ ] Have the designer polish Tino from the brief in `brand/brand.md`.
